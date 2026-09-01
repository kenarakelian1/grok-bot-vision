import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_FRAME_BYTES = 5 * 1024 * 1024;
const TUNNEL_WAIT_MS = 8_000;

const FALLBACK_CAMERA_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Grok Bot Live Camera</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{width:100%;height:100%;background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;overflow:hidden}
    video#cam{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000}
    #status{position:absolute;top:12px;left:12px;z-index:2;display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;background:rgba(0,0,0,.62);font-size:13px;max-width:calc(100% - 24px)}
    #dot{width:8px;height:8px;border-radius:50%;background:#facc15;flex-shrink:0}
    #status.live #dot{background:#22c55e}
    #status.error #dot{background:#ef4444}
    #status.error{background:rgba(80,0,0,.75)}
    #retry{display:none;position:absolute;bottom:24px;left:50%;transform:translateX(-50%);z-index:2;border:0;border-radius:999px;padding:12px 22px;font-size:15px;font-weight:600}
    #retry.show{display:block}
  </style>
</head>
<body>
  <video id="cam" autoplay playsinline muted></video>
  <div id="status"><span id="dot"></span><span id="msg">Requesting camera permission…</span></div>
  <button id="retry" type="button">Try again</button>
  <script>
    const KEY = new URLSearchParams(location.search).get("k") || "__VISION_KEY__";
    const video = document.getElementById("cam");
    const statusEl = document.getElementById("status");
    const msgEl = document.getElementById("msg");
    const retryBtn = document.getElementById("retry");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    let stream = null, timer = null, sending = false, sent = 0, lastErr = "";
    function setStatus(kind, text) {
      statusEl.className = kind === "live" ? "live" : kind === "error" ? "error" : "";
      msgEl.textContent = text;
      retryBtn.classList.toggle("show", kind === "error");
    }
    function liveLabel() {
      return "LIVE · streaming to Grok Bot" + (sent ? " · " + sent + " frames" : "") + (lastErr ? " · send retrying" : "");
    }
    async function start() {
      if (timer) { clearInterval(timer); timer = null; }
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      if (!window.isSecureContext) { setStatus("error", "Camera needs HTTPS or localhost (secure context)."); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setStatus("error", "This browser has no camera API."); return; }
      if (!KEY || KEY === "__VISION_KEY__") { setStatus("error", "Missing camera key. Open the URL from start_camera (it includes ?k=)."); return; }
      setStatus("", "Requesting camera permission…");
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch (err) {
        const name = err && err.name ? err.name : "Error";
        setStatus("error", name === "NotAllowedError" ? "Permission denied. Allow the camera and tap Try again." : (err && err.message) || String(err));
        return;
      }
      video.srcObject = stream;
      try { await video.play(); } catch (_) {}
      setStatus("live", liveLabel());
      timer = setInterval(capture, 250);
    }
    function capture() {
      if (document.hidden || sending || !video.videoWidth) return;
      let w = video.videoWidth, h = video.videoHeight;
      if (w > 1280) { h = Math.round(h * 1280 / w); w = 1280; }
      canvas.width = w; canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      sending = true;
      canvas.toBlob(async (blob) => {
        if (!blob) { sending = false; return; }
        try {
          const res = await fetch("/frame", { method: "POST", headers: { "Content-Type": "image/jpeg", "X-Vision-Key": KEY }, body: blob });
          if (!res.ok) throw new Error("HTTP " + res.status);
          sent += 1; lastErr = "";
          setStatus("live", liveLabel());
        } catch (err) {
          lastErr = err && err.message ? err.message : "send failed";
          setStatus("live", liveLabel());
        } finally { sending = false; }
      }, "image/jpeg", 0.7);
    }
    retryBtn.addEventListener("click", start);
    start();
  </script>
</body>
</html>
`;

export type CameraStartOptions = {
  port?: number;
  key?: string;
  writePaths?: string[];
  tryTunnel?: boolean;
};

export type CameraFrame = {
  buffer: Buffer;
  capturedAt: number;
  bytes: number;
};

export type CameraStatus = {
  running: boolean;
  accepting: boolean;
  hasFrame: boolean;
  lastFrameAgeMs: number | null;
  lastFrameAt: number | null;
  lastFrameBytes: number | null;
  port: number | null;
  boundHosts: string[];
  localUrl: string | null;
  lanUrls: string[];
  tunnelUrl: string | null;
  writePaths: string[];
};

export type CameraStartResult = CameraStatus & {
  key: string;
  instructions: string;
  tunnelNote: string;
};

type InternalState = {
  running: boolean;
  accepting: boolean;
  key: string | null;
  port: number | null;
  boundHosts: string[];
  servers: http.Server[];
  tunnelProc: ChildProcess | null;
  tunnelUrl: string | null;
  writePaths: string[];
  frame: Buffer | null;
  capturedAt: number | null;
};

const state: InternalState = {
  running: false,
  accepting: false,
  key: null,
  port: null,
  boundHosts: [],
  servers: [],
  tunnelProc: null,
  tunnelUrl: null,
  writePaths: [],
  frame: null,
  capturedAt: null,
};

let startLock: Promise<CameraStartResult> | null = null;

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function defaultCameraPort(): number {
  const raw = process.env.PORT;
  if (!raw) return 8765;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return n;
}

export function defaultWritePaths(): string[] {
  if (process.env.VISION_INBOX) {
    return [path.join(path.resolve(process.env.VISION_INBOX), "live.jpg")];
  }
  return [path.resolve(process.cwd(), "live.jpg")];
}

function loadCameraHtml(): string {
  const candidates = [
    path.join(PLUGIN_ROOT, "public", "camera.html"),
    path.join(process.cwd(), "public", "camera.html"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, "utf8");
    } catch {
      // try next
    }
  }
  return FALLBACK_CAMERA_HTML;
}

function injectKey(html: string, key: string): string {
  return html.replaceAll("__VISION_KEY__", key);
}

function headerKey(req: http.IncomingMessage): string | undefined {
  const raw = req.headers["x-vision-key"];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw[0]) return raw[0];
  return undefined;
}

function keysMatch(provided: string | undefined, expected: string | null): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        req.destroy();
        reject(new Error("Frame exceeds size limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function atomicWrite(dest: string, buf: Buffer): void {
  ensureDir(path.dirname(dest));
  const tmp = dest + ".tmp";
  writeFileSync(tmp, buf);
  try {
    renameSync(tmp, dest);
  } catch {
    try {
      unlinkSync(dest);
    } catch {
      // ignore
    }
    renameSync(tmp, dest);
  }
}

function storeFrame(buf: Buffer): void {
  state.frame = buf;
  state.capturedAt = Date.now();
  for (const dest of state.writePaths) {
    try {
      atomicWrite(dest, buf);
    } catch {
      // keep serving in-memory even if disk write fails
    }
  }
}

function send(res: http.ServerResponse, status: number, body: string | Buffer, headers?: Record<string, string>): void {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    ...(isBuf ? { "Content-Length": String(body.length) } : { "Content-Type": "text/plain; charset=utf-8" }),
    ...headers,
  });
  res.end(body);
}

function pathnameOf(req: http.IncomingMessage): { pathname: string; searchParams: URLSearchParams } {
  const host = req.headers.host || "127.0.0.1";
  const url = new URL(req.url || "/", `http://${host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method || "GET";
  const { pathname } = pathnameOf(req);

  if (method === "GET" && (pathname === "/" || pathname === "/camera" || pathname === "/camera.html")) {
    const html = injectKey(loadCameraHtml(), state.key || "");
    send(res, 200, html, { "Content-Type": "text/html; charset=utf-8" });
    return;
  }

  if (method === "GET" && (pathname === "/latest.jpg" || pathname === "/latest.jpeg")) {
    const frame = getLatestFrame();
    if (!frame) {
      send(res, 404, "no frame yet");
      return;
    }
    send(res, 200, frame.buffer, { "Content-Type": "image/jpeg" });
    return;
  }

  if (method === "POST" && pathname === "/frame") {
    if (!state.accepting) {
      send(res, 503, "camera server is not accepting frames");
      return;
    }
    if (!keysMatch(headerKey(req), state.key)) {
      send(res, 401, "missing or invalid X-Vision-Key");
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_FRAME_BYTES);
    } catch (err) {
      send(res, 413, err instanceof Error ? err.message : "body too large");
      return;
    }
    if (!isJpeg(body)) {
      send(res, 400, "body must be image/jpeg");
      return;
    }
    storeFrame(body);
    send(res, 204, "");
    return;
  }

  send(res, 404, "not found");
}

function listenOne(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function lanAddresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.internal) continue;
      if (String(info.family) !== "IPv4" && String(info.family) !== "4") continue;
      out.push(info.address);
    }
  }
  return out;
}

function urlWithKey(origin: string, key: string): string {
  return `${origin}/?k=${encodeURIComponent(key)}`;
}

function whichCloudflared(): string | null {
  const parts = (process.env.PATH || "").split(path.delimiter);
  const names = process.platform === "win32" ? ["cloudflared.exe", "cloudflared"] : ["cloudflared"];
  for (const dir of parts) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (existsSync(full) && statSync(full).isFile()) return full;
      } catch {
        // next
      }
    }
  }
  return null;
}

function parseTunnelUrl(text: string): string | null {
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

async function startTunnel(port: number): Promise<{ url: string | null; note: string; proc: ChildProcess | null }> {
  const bin = whichCloudflared();
  if (!bin) {
    return {
      url: null,
      note: "cloudflared not found on PATH — local URL only. Phone cameras need HTTPS; install cloudflared for a quick public tunnel.",
      proc: null,
    };
  }
  const proc = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let buf = "";
  let url: string | null = null;
  const onData = (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    if (!url) url = parseTunnelUrl(buf);
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("error", () => {
    /* ENOENT after spawn is unlikely */
  });

  const started = Date.now();
  while (!url && Date.now() - started < TUNNEL_WAIT_MS && proc.exitCode == null) {
    await new Promise((r) => setTimeout(r, 150));
  }
  if (url) {
    return { url, note: "Public HTTPS tunnel is ready (required for a phone camera).", proc };
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
  return {
    url: null,
    note: "cloudflared started but no trycloudflare.com URL appeared in time — local URL only.",
    proc: null,
  };
}

function killTunnel(): void {
  const proc = state.tunnelProc;
  state.tunnelProc = null;
  state.tunnelUrl = null;
  if (!proc || proc.killed) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
  setTimeout(() => {
    try {
      if (!proc.killed && proc.exitCode == null) proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 1500).unref();
}

function closeServers(): Promise<void> {
  const servers = state.servers.splice(0, state.servers.length);
  state.boundHosts = [];
  return Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          try {
            if (typeof (s as http.Server & { closeAllConnections?: () => void }).closeAllConnections === "function") {
              (s as http.Server & { closeAllConnections: () => void }).closeAllConnections();
            }
          } catch {
            // ignore
          }
          s.close(() => resolve());
          setTimeout(resolve, 1000).unref();
        }),
    ),
  ).then(() => undefined);
}

function snapshotStatus(): CameraStatus {
  const now = Date.now();
  const hasFrame = Boolean(state.frame) || Boolean(readFrameFromDisk());
  const capturedAt = state.capturedAt ?? diskMtime();
  return {
    running: state.running,
    accepting: state.accepting,
    hasFrame,
    lastFrameAgeMs: capturedAt != null ? Math.max(0, now - capturedAt) : null,
    lastFrameAt: capturedAt,
    lastFrameBytes: state.frame?.length ?? readFrameFromDisk()?.bytes ?? null,
    port: state.port,
    boundHosts: [...state.boundHosts],
    localUrl: state.running && state.port && state.key ? urlWithKey(`http://127.0.0.1:${state.port}`, state.key) : null,
    lanUrls:
      state.running && state.port && state.key
        ? lanAddresses().map((ip) => urlWithKey(`http://${ip}:${state.port}`, state.key!))
        : [],
    tunnelUrl: state.tunnelUrl && state.key ? urlWithKey(state.tunnelUrl, state.key) : state.tunnelUrl,
    writePaths: [...state.writePaths],
  };
}

function diskMtime(): number | null {
  for (const p of state.writePaths) {
    try {
      if (existsSync(p)) return statSync(p).mtimeMs;
    } catch {
      // next
    }
  }
  return null;
}

function readFrameFromDisk(): CameraFrame | null {
  for (const p of state.writePaths) {
    try {
      if (!existsSync(p)) continue;
      const buf = readFileSync(p);
      if (!isJpeg(buf)) continue;
      const st = statSync(p);
      return { buffer: buf, capturedAt: st.mtimeMs, bytes: buf.length };
    } catch {
      // next
    }
  }
  return null;
}

export function getLatestFrame(): CameraFrame | null {
  if (state.frame && state.capturedAt) {
    return { buffer: state.frame, capturedAt: state.capturedAt, bytes: state.frame.length };
  }
  return readFrameFromDisk();
}

export function getCameraStatus(): CameraStatus {
  return snapshotStatus();
}

export async function stopCameraServer(): Promise<CameraStatus> {
  state.accepting = false;
  state.running = false;
  killTunnel();
  await closeServers();
  state.port = null;
  state.key = null;
  return snapshotStatus();
}

async function startCameraServerInner(opts: CameraStartOptions = {}): Promise<CameraStartResult> {
  if (state.running) {
    const status = snapshotStatus();
    return {
      ...status,
      key: state.key || "",
      instructions:
        "Camera server already running. Open the local URL (or HTTPS tunnel URL) on a phone or computer that has a camera, then allow the camera prompt.",
      tunnelNote: state.tunnelUrl
        ? "Public HTTPS tunnel is active."
        : "No public HTTPS tunnel. Local URL works on this machine; a phone needs HTTPS.",
    };
  }

  const port = opts.port ?? defaultCameraPort();
  const key = opts.key || process.env.VISION_KEY || randomBytes(16).toString("hex");
  const writePaths = (opts.writePaths && opts.writePaths.length ? opts.writePaths : defaultWritePaths()).map((p) =>
    path.resolve(p),
  );
  for (const p of writePaths) ensureDir(path.dirname(p));

  state.key = key;
  state.port = port;
  state.writePaths = writePaths;
  state.accepting = true;
  state.tunnelUrl = null;

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    handle(req, res).catch(() => {
      try {
        send(res, 500, "internal error");
      } catch {
        // ignore
      }
    });
  };

  // Bind 0.0.0.0 (all interfaces, includes 127.0.0.1) and also 127.0.0.1
  // explicitly. If the second bind fails because the first already covers it,
  // that is expected and ignored.
  const hosts = ["0.0.0.0", "127.0.0.1"] as const;
  const bound: string[] = [];
  const errors: string[] = [];
  for (const host of hosts) {
    const server = http.createServer(handler);
    try {
      await listenOne(server, port, host);
      state.servers.push(server);
      bound.push(host);
    } catch (err) {
      try {
        server.close();
      } catch {
        // ignore
      }
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${host}: ${msg}`);
    }
  }
  if (bound.length === 0) {
    state.accepting = false;
    state.key = null;
    state.port = null;
    throw new Error(`Failed to bind camera HTTP server on port ${port} (${errors.join("; ")})`);
  }
  state.boundHosts = bound;
  state.running = true;

  let tunnelNote = "No public HTTPS tunnel (not requested).";
  if (opts.tryTunnel !== false) {
    const tunnel = await startTunnel(port);
    if (tunnel.proc && tunnel.url) {
      state.tunnelProc = tunnel.proc;
      state.tunnelUrl = tunnel.url;
    } else if (tunnel.proc) {
      try {
        tunnel.proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    tunnelNote = tunnel.note;
  }

  const status = snapshotStatus();
  const openUrl = status.tunnelUrl || status.localUrl || `http://127.0.0.1:${port}/?k=${key}`;
  const instructions = [
    "Open this URL on a phone or computer that has a camera, then allow the camera prompt:",
    openUrl,
    "",
    `Local (this machine, localhost is a secure context): ${status.localUrl}`,
    status.tunnelUrl
      ? `Public HTTPS (use this on a phone): ${status.tunnelUrl}`
      : "No public HTTPS tunnel — a phone browser cannot use getUserMedia on plain http://LAN-IP.",
    "",
    "After the page says LIVE, call look_camera to see the current frame.",
  ].join("\n");

  return {
    ...status,
    key,
    instructions,
    tunnelNote,
  };
}

export async function startCameraServer(opts: CameraStartOptions = {}): Promise<CameraStartResult> {
  if (startLock) return startLock;
  startLock = startCameraServerInner(opts).finally(() => {
    startLock = null;
  });
  return startLock;
}
