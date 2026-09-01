import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import {
  startCameraServer,
  stopCameraServer,
  getLatestFrame,
  getCameraStatus,
} from "./camera-http.js";

const execFileAsync = promisify(execFile);

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_INBOX = path.join(PLUGIN_ROOT, "inbox");
const PRIMARY_INBOX = path.resolve(process.env.VISION_INBOX || "/home/box/vision-inbox");

const MAX_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const PDF_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PAGES = 8;
const HARD_MAX_PAGES = 20;

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function inboxRoots(): string[] {
  ensureDir(PRIMARY_INBOX);
  ensureDir(PLUGIN_INBOX);
  const roots = [PRIMARY_INBOX, PLUGIN_INBOX];
  const unique: string[] = [];
  for (const r of roots) {
    let resolved = r;
    try {
      resolved = realpathSync(r);
    } catch {
      // directory may be brand new
    }
    if (!unique.includes(resolved)) unique.push(resolved);
  }
  return unique;
}

function isInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
  const cleaned = base.replace(/^\.+/, "") || "download";
  return cleaned.slice(0, 180);
}

function uniqueDest(dir: string, filename: string): string {
  const parsed = path.parse(sanitizeFilename(filename));
  let candidate = path.join(dir, parsed.name + parsed.ext);
  let i = 1;
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name}-${i}${parsed.ext}`);
    i += 1;
  }
  return candidate;
}

function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}

function mimeFromMagic(buf: Buffer, fallback: string): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  if (buf.length >= 6) {
    const sig = buf.subarray(0, 6).toString("ascii");
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07) && (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08)) {
    return fallback.includes("wordprocessingml")
      ? fallback
      : "application/zip";
  }
  return fallback;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function ok(content: ContentBlock[]) {
  return { content };
}

/**
 * Resolve a user-supplied path to a real file inside an allowed inbox.
 * Rejects file-scheme URLs and any path that escapes inbox roots.
 */
function resolveInboxFile(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("path is empty");
  if (/^file:/i.test(trimmed)) {
    throw new Error("file-scheme URLs are not allowed; drop the file in the inbox and pass its filename");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !path.isAbsolute(trimmed)) {
    throw new Error("Only inbox filesystem paths are accepted for path=");
  }

  const roots = inboxRoots();
  const candidates: string[] = [];
  if (path.isAbsolute(trimmed)) {
    candidates.push(path.resolve(trimmed));
  } else {
    for (const root of roots) {
      candidates.push(path.resolve(root, trimmed));
    }
  }

  let lastErr = "File not found in inbox";
  for (const candidate of candidates) {
    const inside = roots.some((root) => isInside(candidate, root));
    if (!inside) {
      lastErr = "Path is outside the allowed inbox directories";
      continue;
    }
    if (!existsSync(candidate)) {
      lastErr = `File not found: ${path.basename(candidate)}`;
      continue;
    }
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      lastErr = "Unable to resolve path";
      continue;
    }
    const stillInside = roots.some((root) => {
      let realRoot = root;
      try {
        realRoot = realpathSync(root);
      } catch {
        // ignore
      }
      return isInside(real, realRoot);
    });
    if (!stillInside) {
      lastErr = "Path is outside the allowed inbox directories";
      continue;
    }
    const st = statSync(real);
    if (!st.isFile()) {
      lastErr = "Path is not a file";
      continue;
    }
    return real;
  }
  throw new Error(lastErr);
}

async function readCapped(filePath: string): Promise<Buffer> {
  const st = statSync(filePath);
  if (st.size > MAX_BYTES) {
    throw new Error(`File exceeds 20MB limit (${formatBytes(st.size)})`);
  }
  return readFileSync(filePath);
}

function extForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return ".docx";
    default:
      return "";
  }
}

function mimeFromContentType(ct: string | null): string | undefined {
  if (!ct) return undefined;
  const raw = ct.split(";")[0].trim().toLowerCase();
  if (IMAGE_MIMES.has(raw)) return raw;
  if (raw === "application/pdf") return raw;
  if (raw === "text/plain" || raw === "text/markdown") return raw;
  if (raw === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return raw;
  if (raw === "application/octet-stream") return undefined;
  return raw;
}

async function downloadToInbox(urlStr: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed, {
      signal: ac.signal,
      redirect: "follow",
      headers: { "user-agent": "grok-bot-vision/0.2.0" },
    });
    if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`.trim());
    }
    const cl = res.headers.get("content-length");
    if (cl && Number(cl) > MAX_BYTES) {
      throw new Error("Remote file exceeds 20MB limit");
    }
    if (!res.body) throw new Error("Empty response body");

    const headerMime = mimeFromContentType(res.headers.get("content-type"));
    let urlName = sanitizeFilename(decodeURIComponent(path.posix.basename(parsed.pathname) || "download"));
    if (!path.extname(urlName) && headerMime) {
      urlName += extForMime(headerMime);
    }

    ensureDir(PRIMARY_INBOX);
    const dest = uniqueDest(PRIMARY_INBOX, urlName);
    const tmp = dest + ".part";

    const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    let total = 0;
    nodeStream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        nodeStream.destroy(new Error("Remote file exceeds 20MB limit"));
      }
    });

    const out = createWriteStream(tmp);
    try {
      await pipeline(nodeStream, out);
    } catch (err) {
      try {
        await fs.unlink(tmp);
      } catch {
        // ignore
      }
      throw err;
    }

    const buf = readFileSync(tmp);
    const magicMime = mimeFromMagic(buf, headerMime || mimeFromExt(dest));
    let finalDest = dest;
    if (!path.extname(path.basename(dest)) && extForMime(magicMime)) {
      finalDest = uniqueDest(PRIMARY_INBOX, sanitizeFilename(urlName + extForMime(magicMime)));
    }
    await fs.rename(tmp, finalDest);
    return finalDest;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Download timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function resolvePathOrUrl(args: { path?: string; url?: string }): Promise<{ filePath: string; source: string }> {
  const hasPath = Boolean(args.path && args.path.trim());
  const hasUrl = Boolean(args.url && args.url.trim());
  if (hasPath === hasUrl) {
    throw new Error("Provide exactly one of path or url");
  }
  if (hasUrl) {
    const filePath = await downloadToInbox(args.url!.trim());
    return { filePath, source: args.url!.trim() };
  }
  const filePath = resolveInboxFile(args.path!);
  return { filePath, source: filePath };
}

function imageBlock(buf: Buffer, mimeType: ImageMime): ContentBlock {
  return { type: "image", data: buf.toString("base64"), mimeType };
}

function asImageMime(mime: string): ImageMime | null {
  if (IMAGE_MIMES.has(mime)) return mime as ImageMime;
  return null;
}

function loadImage(filePath: string): { block: ContentBlock; caption: string; mime: ImageMime } {
  const buf = readFileSync(filePath);
  if (buf.length > MAX_BYTES) {
    throw new Error(`File exceeds 20MB limit (${formatBytes(buf.length)})`);
  }
  const mime = mimeFromMagic(buf, mimeFromExt(filePath));
  const imageMime = asImageMime(mime);
  if (!imageMime) {
    throw new Error(`Not a supported image (jpeg/png/gif/webp). Detected: ${mime}`);
  }
  const name = path.basename(filePath);
  const caption = `Image: ${name} (${imageMime}, ${formatBytes(buf.length)})`;
  return { block: imageBlock(buf, imageMime), caption, mime: imageMime };
}

function listInboxFiles(): Array<{
  name: string;
  path: string;
  inbox: string;
  size: number;
  mime: string;
  mtime: string;
}> {
  const items: Array<{
    name: string;
    path: string;
    inbox: string;
    size: number;
    mime: string;
    mtime: string;
  }> = [];
  for (const root of inboxRoots()) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === ".gitkeep" || name.startsWith(".")) continue;
      if (name.endsWith(".part")) continue;
      const full = path.join(root, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      let mime = mimeFromExt(full);
      try {
        const head = Buffer.alloc(16);
        const fd = readFileSync(full).subarray(0, 16);
        mime = mimeFromMagic(fd, mime);
      } catch {
        // keep ext mime
      }
      items.push({
        name,
        path: full,
        inbox: root,
        size: st.size,
        mime,
        mtime: st.mtime.toISOString(),
      });
    }
  }
  items.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return items;
}

function popplerMissing(err: unknown): boolean {
  const anyErr = err as { code?: string; message?: string };
  return anyErr?.code === "ENOENT" || /not found|ENOENT/i.test(anyErr?.message || "");
}

const POPPLER_HELP =
  "PDF rendering requires poppler-utils (pdftotext, pdftoppm). Install with your package manager, e.g. apt-get install poppler-utils";

async function renderPdf(filePath: string, maxPages: number): Promise<ContentBlock[]> {
  const pages = Math.min(Math.max(1, maxPages), HARD_MAX_PAGES);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grok-bot-vision-pdf-"));
  const prefix = path.join(tmpDir, "page");
  const blocks: ContentBlock[] = [];

  try {
    let textOut = "";
    try {
      const { stdout } = await execFileAsync(
        "pdftotext",
        ["-f", "1", "-l", String(pages), "-layout", filePath, "-"],
        { timeout: PDF_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      );
      textOut = (stdout || "").trim();
    } catch (err) {
      if (popplerMissing(err)) throw new Error(POPPLER_HELP);
      const message = err instanceof Error ? err.message : String(err);
      textOut = `(pdftotext failed: ${message})`;
    }

    try {
      await execFileAsync("pdftoppm", ["-png", "-f", "1", "-l", String(pages), filePath, prefix], {
        timeout: PDF_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (err) {
      if (popplerMissing(err)) throw new Error(POPPLER_HELP);
      throw new Error(`pdftoppm failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const files = (await fs.readdir(tmpDir))
      .filter((n) => n.startsWith("page") && n.endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const caption = [
      `PDF: ${path.basename(filePath)}`,
      `pages rendered: ${files.length} (max_pages=${pages})`,
      textOut ? `--- extracted text ---\n${textOut}` : "(no extractable text)",
    ].join("\n");
    blocks.push({ type: "text", text: caption });

    for (const name of files) {
      const png = await fs.readFile(path.join(tmpDir, name));
      if (png.length > MAX_BYTES) continue;
      blocks.push(imageBlock(png, "image/png"));
    }
    if (files.length === 0) {
      blocks.push({ type: "text", text: "pdftoppm produced no page images." });
    }
    return blocks;
  } finally {
    try {
      const leftover = await fs.readdir(tmpDir);
      await Promise.all(leftover.map((n) => fs.unlink(path.join(tmpDir, n)).catch(() => undefined)));
      await fs.rmdir(tmpDir).catch(() => undefined);
    } catch {
      // ignore cleanup
    }
  }
}

function stripXml(xml: string): string {
  return xml
    .replace(/<w:p[^>]*>/g, "\n")
    .replace(/<w:tab[^/]*\/>/g, "\t")
    .replace(/<w:br[^/]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractDocxText(buf: Buffer): string {
  let offset = 0;
  while (offset < buf.length - 30) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) {
      const next = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), offset + 1);
      if (next < 0) break;
      offset = next;
      continue;
    }
    const method = buf.readUInt16LE(offset + 8);
    const flags = buf.readUInt16LE(offset + 6);
    let compressedSize = buf.readUInt32LE(offset + 18);
    const fileNameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + fileNameLen).toString("utf8");
    const dataStart = offset + 30 + fileNameLen + extraLen;
    if (flags & 0x08) {
      // data descriptor: scan for the next local header; not typical for docx
      offset = dataStart;
      continue;
    }
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    if (name === "word/document.xml") {
      let xml: Buffer;
      if (method === 0) xml = Buffer.from(data);
      else if (method === 8) xml = inflateRawSync(data);
      else throw new Error(`Unsupported zip compression method ${method} in docx`);
      const text = stripXml(xml.toString("utf8"));
      if (!text) throw new Error("docx contained no extractable text");
      return text;
    }
    offset = dataStart + compressedSize;
  }
  throw new Error("word/document.xml not found in docx");
}

async function showDocument(filePath: string, maxPages: number): Promise<ContentBlock[]> {
  const st = statSync(filePath);
  if (st.size > MAX_BYTES) {
    throw new Error(`File exceeds 20MB limit (${formatBytes(st.size)})`);
  }
  const buf = readFileSync(filePath);
  const mime = mimeFromMagic(buf, mimeFromExt(filePath));
  const name = path.basename(filePath);

  const imageMime = asImageMime(mime);
  if (imageMime) {
    const { block, caption } = loadImage(filePath);
    return [block, { type: "text", text: `Document (image): ${caption}` }];
  }

  if (mime === "application/pdf" || path.extname(name).toLowerCase() === ".pdf") {
    return renderPdf(filePath, maxPages);
  }

  if (mime === "text/plain" || mime === "text/markdown" || [".txt", ".md", ".markdown"].includes(path.extname(name).toLowerCase())) {
    const text = buf.toString("utf8");
    return [{ type: "text", text: `Document: ${name} (${mime}, ${formatBytes(buf.length)})\n\n${text}` }];
  }

  const isDocx =
    path.extname(name).toLowerCase() === ".docx" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/zip";
  if (isDocx && path.extname(name).toLowerCase() === ".docx") {
    const text = extractDocxText(buf);
    return [
      {
        type: "text",
        text: `Document: ${name} (docx, ${formatBytes(buf.length)})\n\n${text}`,
      },
    ];
  }

  throw new Error(
    `Unsupported document type (${mime}). Supported: pdf, jpeg, png, gif, webp, txt, md, docx`,
  );
}

const server = new McpServer({
  name: "grok-bot-vision",
  version: "0.2.0",
});

server.tool(
  "list_shown",
  "List files currently in the vision inbox directories (name, size, mime, mtime).",
  async () => {
    try {
      const files = listInboxFiles();
      if (files.length === 0) {
        return ok([
          {
            type: "text",
            text: `Inbox is empty.\nPrimary: ${PRIMARY_INBOX}\nPlugin inbox: ${PLUGIN_INBOX}\nDrop jpeg/png/gif/webp/pdf/txt/md/docx files there, then call show_image or show_document.`,
          },
        ]);
      }
      const lines = files.map((f) => {
        return `- ${f.name}\n  path: ${f.path}\n  size: ${formatBytes(f.size)} (${f.size} bytes)\n  mime: ${f.mime}\n  mtime: ${f.mtime}`;
      });
      return ok([{ type: "text", text: `Shown files (${files.length}):\n\n${lines.join("\n\n")}` }]);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

server.tool(
  "show_image",
  "Load a jpeg/png/gif/webp from an inbox path or a public http(s) URL and return real MCP image content so the model can see the pixels.",
  {
    path: z.string().optional().describe("Path to an image already in the vision inbox"),
    url: z.string().optional().describe("Public http or https URL of an image to download into the inbox"),
  },
  async ({ path: inputPath, url }) => {
    try {
      const { filePath, source } = await resolvePathOrUrl({ path: inputPath, url });
      const { block, caption } = loadImage(filePath);
      return ok([
        block,
        { type: "text", text: `${caption}\nsource: ${source}\nfile: ${filePath}` },
      ]);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

server.tool(
  "show_document",
  "Load a PDF, image, txt/md, or docx from an inbox path or public http(s) URL. PDFs return extracted text plus page raster images (poppler). Rejects files over 20MB.",
  {
    path: z.string().optional().describe("Path to a document already in the vision inbox"),
    url: z.string().optional().describe("Public http or https URL of a document to download into the inbox"),
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(HARD_MAX_PAGES)
      .optional()
      .describe("Max PDF pages to rasterize (default 8)"),
  },
  async ({ path: inputPath, url, max_pages }) => {
    try {
      const { filePath, source } = await resolvePathOrUrl({ path: inputPath, url });
      const blocks = await showDocument(filePath, max_pages ?? DEFAULT_MAX_PAGES);
      blocks.push({ type: "text", text: `source: ${source}\nfile: ${filePath}` });
      return ok(blocks);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

server.tool(
  "inbox_info",
  "Return the absolute vision inbox path and instructions for dropping files so Grok Bot can see them.",
  async () => {
    inboxRoots();
    const text = [
      "Primary: live camera — call start_camera, open the URL on a device with a webcam, allow permission, then look_camera.",
      "Secondary: file inbox — drop pictures, screenshots, PDFs, or docs, then list_shown / show_image / show_document.",
      "",
      `Primary inbox: ${PRIMARY_INBOX}`,
      `  (override with env VISION_INBOX)`,
      `Plugin inbox:  ${PLUGIN_INBOX}`,
      "",
      "Accepted: jpeg, png, gif, webp, pdf, txt, md, docx. Max 20MB.",
      "Public http/https URLs can be passed to show_image or show_document; they are downloaded into the primary inbox.",
      "Paths outside these directories are rejected. Uploaded files are never executed.",
    ].join("\n");
    return ok([{ type: "text", text }]);
  },
);


function uniquePaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

function mcpCameraWritePaths(): string[] {
  return uniquePaths([path.join(PRIMARY_INBOX, "live.jpg"), path.join(PLUGIN_INBOX, "live.jpg")]);
}

function inboxLiveFrame(): { buffer: Buffer; capturedAt: number; filePath: string } | null {
  const candidates = uniquePaths([
    path.join(PRIMARY_INBOX, "live.jpg"),
    path.join(PLUGIN_INBOX, "live.jpg"),
    path.resolve(process.cwd(), "live.jpg"),
  ]);
  let best: { buffer: Buffer; capturedAt: number; filePath: string } | null = null;
  for (const filePath of candidates) {
    try {
      if (!existsSync(filePath)) continue;
      const st = statSync(filePath);
      if (!st.isFile() || st.size < 3) continue;
      const buf = readFileSync(filePath);
      if (!(buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) continue;
      if (!best || st.mtimeMs > best.capturedAt) {
        best = { buffer: buf, capturedAt: st.mtimeMs, filePath };
      }
    } catch {
      // next
    }
  }
  return best;
}

function resolveLiveFrame(): {
  buffer: Buffer;
  capturedAt: number;
  source: string;
} | null {
  const mem = getLatestFrame();
  const disk = inboxLiveFrame();
  if (mem && disk) {
    if (mem.capturedAt >= disk.capturedAt) {
      return { buffer: mem.buffer, capturedAt: mem.capturedAt, source: "live stream" };
    }
    return { buffer: disk.buffer, capturedAt: disk.capturedAt, source: disk.filePath };
  }
  if (mem) return { buffer: mem.buffer, capturedAt: mem.capturedAt, source: "live stream" };
  if (disk) return { buffer: disk.buffer, capturedAt: disk.capturedAt, source: disk.filePath };
  return null;
}

server.tool(
  "start_camera",
  "Start the live device camera page. Returns a local URL (and a public HTTPS tunnel URL if cloudflared is installed). Open that URL on a phone or computer with a camera, allow the prompt, then call look_camera to see live frames.",
  async () => {
    try {
      inboxRoots();
      const result = await startCameraServer({
        tryTunnel: true,
        writePaths: mcpCameraWritePaths(),
      });
      const text = [
        result.instructions,
        "",
        result.tunnelNote,
        `Bound hosts: ${result.boundHosts.join(", ") || "none"}`,
        `Port: ${result.port}`,
        `Writing live.jpg to: ${result.writePaths.join(", ")}`,
      ].join("\n");
      return ok([{ type: "text", text }]);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

server.tool(
  "look_camera",
  "Return the latest live camera JPEG as real MCP image content so the model can see the pixels. If no frame yet, reports that it is waiting for camera permission / first frame.",
  async () => {
    try {
      const frame = resolveLiveFrame();
      if (!frame) {
        return ok([
          {
            type: "text",
            text: "Waiting for camera permission / first frame. Call start_camera, open the camera URL on a device with a webcam, and allow the camera prompt.",
          },
        ]);
      }
      const age = Math.max(0, Date.now() - frame.capturedAt);
      return ok([
        imageBlock(frame.buffer, "image/jpeg"),
        {
          type: "text",
          text: `Live camera frame (${formatBytes(frame.buffer.length)}, ${age} ms ago)\nsource: ${frame.source}`,
        },
      ]);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

server.tool(
  "stop_camera",
  "Stop accepting live camera frames and stop the camera HTTP server (and any HTTPS tunnel).",
  async () => {
    try {
      const status = await stopCameraServer();
      const still = resolveLiveFrame();
      const text = [
        "Camera server stopped. New frames are not accepted.",
        status.hasFrame || still
          ? "The last captured frame is still available via look_camera."
          : "No frame was captured.",
      ].join("\n");
      return ok([{ type: "text", text }]);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

server.tool(
  "camera_status",
  "Live camera status: running?, last frame age ms, hasFrame, local and tunnel URLs.",
  async () => {
    try {
      const status = getCameraStatus();
      const frame = resolveLiveFrame();
      const age = frame ? Math.max(0, Date.now() - frame.capturedAt) : status.lastFrameAgeMs;
      const lines = [
        `running: ${status.running ? "yes" : "no"}`,
        `accepting: ${status.accepting ? "yes" : "no"}`,
        `hasFrame: ${frame || status.hasFrame ? "yes" : "no"}`,
        `lastFrameAgeMs: ${age ?? "n/a"}`,
        `lastFrameBytes: ${frame?.buffer.length ?? status.lastFrameBytes ?? "n/a"}`,
        `port: ${status.port ?? "n/a"}`,
        `boundHosts: ${status.boundHosts.join(", ") || "n/a"}`,
        `localUrl: ${status.localUrl ?? "n/a"}`,
        `tunnelUrl: ${status.tunnelUrl ?? "n/a"}`,
        status.lanUrls.length ? `lanUrls:\n  ${status.lanUrls.join("\n  ")}` : "lanUrls: none",
        `writePaths: ${status.writePaths.join(", ") || "n/a"}`,
      ];
      return ok([{ type: "text", text: lines.join("\n") }]);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

async function main(): Promise<void> {
  inboxRoots();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
