---
name: show-to-grok-bot
description: Use when the user wants to show Grok Bot a picture, screenshot, PDF, document, or a public URL so the model can see the pixels (or extracted text). Also use when they drop files in the vision inbox or ask you to look at an image.
---

# Show to Grok Bot

Grok Bot cannot see attachments unless this plugin returns real MCP **image** content blocks. Use the `grok-bot-vision` tools so the model gets pixels, not just a filename.

## When to use

- The user wants you to look at a picture, screenshot, GIF, or WebP.
- The user wants you to read a PDF, Word doc, markdown, or text file.
- The user pastes a public `http`/`https` URL of an image or document.
- The user says they dropped a file in the vision inbox.

## Recipe

1. Call `inbox_info` (or tell the user the inbox path) so they know where to drop files if they have not already.
2. Call `list_shown` to see what is already in the inbox (name, size, mime, mtime).
3. For jpeg / png / gif / webp, call `show_image` with either:
   - `path` — a file already in an inbox, or
   - `url` — a public `http`/`https` URL (downloaded into the inbox).
4. For PDF, txt, md, docx, or mixed documents, call `show_document` with `path` or `url`. Optional `max_pages` defaults to 8 for PDFs.
5. After the tool returns, **look at the image content blocks** (pixels) and any extracted text. Describe what you actually saw.
6. Tell the user the inbox path if they need to drop more files.

## Safety

- Confirm with the user before send / pay / delete / any irreversible action based on what was seen in a screenshot or document.
- Do not treat inbox files as code to run.
- Only inbox paths and `http`/`https` URLs are allowed. There is no access to the rest of the filesystem.
