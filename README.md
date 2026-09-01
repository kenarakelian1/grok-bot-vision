# Vision (grok-bot-vision)

Show Grok Bot pictures, screenshots, PDFs, and documents so it can see them.
MCP image content blocks: type image, base64 pixels, mime type.

Plugin id: grok-bot-vision
Display: Vision
Author: Ken Arakelian
Version: 0.1.0

## Inbox

Default inbox: /home/box/vision-inbox (VISION_INBOX env).
Also: plugin inbox/ directory.

## Connect

command: node
args: ["/workspace/grok-bot-vision-plugin/dist/index.js"]
env: VISION_INBOX=/home/box/vision-inbox

mcp.json uses stdio with args ["./dist/index.js"] and cwd PLUGIN_ROOT.

## Tools

- list_shown: list inbox files (name, size, mime, mtime)
- show_image: path or url; jpeg/png/gif/webp; returns image content plus caption
- show_document: path or url, max_pages default 8; PDF text plus page PNGs, images, txt/md, docx; reject over 20MB
- inbox_info: absolute inbox path and how to drop files

## Build

Requires Node 20. Compile with tsc via the package build script.
PDF rendering needs poppler-utils (pdftotext and pdftoppm).

## Security

- Paths must stay inside inbox dirs (no traversal)
- file-scheme URLs to the rest of the filesystem are rejected
- Dropped files are never launched
- URL fetch is http/https only, with timeout and a 20MB size cap
