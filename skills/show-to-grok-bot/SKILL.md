---
name: show-to-grok-bot
description: Use when the user wants Grok Bot to see a live camera, a picture, screenshot, PDF, document, or a public URL. Prefer the live camera tools (start_camera / look_camera). Also use when they drop files in the vision inbox.
---

# Show to Grok Bot

Grok Bot cannot see attachments unless this plugin returns real MCP **image** content blocks. **Live camera is the product.** File inbox is secondary.

## Live camera (default)

1. Call `start_camera`. It starts a tiny HTTP server and returns `http://127.0.0.1:8765/?k=...` (and a public HTTPS tunnel URL if `cloudflared` is available).
2. Tell the user: open that URL on a phone or computer that has a camera, then **allow the camera prompt**. The page must be HTTPS or localhost.
3. Call `look_camera` to receive the latest JPEG as image content. If there is no frame yet, it is waiting for permission / the first frame — ask the user to allow the camera and retry.
4. Call `camera_status` for running / last frame age / URLs.
5. Call `stop_camera` when finished.

After `look_camera` returns, **look at the image content block** (pixels) and describe what you actually saw.

## File inbox (secondary)

Use when the user dropped a file or pasted a URL instead of using the camera.

1. Call `inbox_info` or `list_shown`.
2. For jpeg / png / gif / webp, call `show_image` with `path` or `url`.
3. For PDF, txt, md, docx, call `show_document` with `path` or `url`. Optional `max_pages` defaults to 8.

## Safety

- Confirm with the user before send / pay / delete / any irreversible action based on what was seen.
- Do not treat inbox files as code to run.
- Only inbox paths and `http`/`https` URLs are allowed for file tools. Camera frames come from the live `/frame` endpoint with a secret key.
