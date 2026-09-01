# Vision (grok-bot-vision)

**Live camera first.** Open a page on a phone or computer, allow the camera, and Grok Bot sees the live JPEG frames as real MCP image content.

File upload / inbox is secondary. This plugin is not a file-drop product.

Plugin id: grok-bot-vision
Display: Vision
Author: Ken Arakelian
Version: 0.2.0

## Live camera

1. Call **start_camera** (or run the standalone server). You get a local URL like http://127.0.0.1:8765/?k=TOKEN.
2. Open that URL on a device with a webcam. Browsers only allow getUserMedia in a **secure context**: HTTPS or localhost.
3. Allow the camera prompt. The page shows the live video full-viewport and POSTs a JPEG (about 250ms, quality 0.7, max width 1280) to /frame.
4. Call **look_camera**. The latest frame is returned as MCP image content so the model can see the pixels.
5. Call **camera_status** anytime. Call **stop_camera** when you are done.

If cloudflared is on PATH, start_camera tries a quick HTTPS tunnel so a phone can open the page. Plain http LAN IP is not a secure context, so the camera prompt will fail. If there is no tunnel, use the local URL on the same machine.

### Standalone server (for example on Ken's Mac)

After compiling, use the package.json "camera" script (entry dist/camera-server.js). Default port: 8765 (PORT env). Frames write to VISION_INBOX/live.jpg, or ./live.jpg in the current working directory if VISION_INBOX is unset.

Copy dist/ plus public/camera.html (or the whole plugin folder). public/camera.html is the camera page; a fallback copy is embedded if the file is missing.

### HTTP endpoints

- GET / or /camera — camera page (token injected; also pass ?k= and send it as X-Vision-Key)
- POST /frame — raw image/jpeg body; requires header X-Vision-Key; stores latest frame in memory and writes live.jpg
- GET /latest.jpg — latest JPEG

The server uses loopback plus all-interface listen. Rejects POSTs without the key.

## Inbox (secondary)

Default inbox: /home/box/vision-inbox (VISION_INBOX env).
Also: plugin inbox/ directory.

Drop jpeg/png/gif/webp/pdf/txt/md/docx if you need file vision. Live camera writes live.jpg into the inbox as well.

## Connect

command: node
args: ["/workspace/grok-bot-vision-plugin/dist/index.js"]
env: VISION_INBOX=/home/box/vision-inbox

mcp.json uses stdio with args ["./dist/index.js"] and cwd PLUGIN_ROOT.

## Tools

- start_camera: start the camera page server, random key, local URL, optional cloudflared HTTPS tunnel
- look_camera: latest live JPEG as MCP image content (or waiting for permission / first frame)
- stop_camera: stop accepting frames / stop the page server
- camera_status: running?, last frame age ms, hasFrame, urls
- list_shown: list inbox files (name, size, mime, mtime)
- show_image: path or url; jpeg/png/gif/webp; returns image content plus caption
- show_document: path or url, max_pages default 8; PDF text plus page PNGs, images, txt/md, docx; reject over 20MB
- inbox_info: live camera reminder plus absolute inbox path

## Build

Requires Node 20. Compile with tsc via the package build script. The camera script is "camera" in package.json; MCP stdio is "start".

PDF rendering needs poppler-utils (pdftotext and pdftoppm).

## Security

- Camera POSTs require X-Vision-Key (from ?k= / injected token)
- Paths must stay inside inbox dirs (no traversal)
- file-scheme URLs to the rest of the filesystem are rejected
- Dropped files are never launched
- URL fetch is http/https only, with timeout and a 20MB size cap
- getUserMedia requires HTTPS or localhost

