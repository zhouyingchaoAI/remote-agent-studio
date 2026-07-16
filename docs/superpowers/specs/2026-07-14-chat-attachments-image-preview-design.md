# Chat Attachments and Generated Image Preview Design

## Goal

Add Codex Desktop-like attachments and generated-image previews to the existing chat flow without replacing the current `codex exec --json` architecture.

## Scope

- Select or drag multiple files into the chat composer.
- Accept images, documents, and code files up to 20 MB each.
- Store remote attachments under `~/.remote-agent-studio/attachments/<conversation-id>/<message-id>/`.
- Support attachments for Codex and Claude Code.
- Pass image attachments to Codex with `--image`; describe other attachments to agents using escaped remote paths.
- Let Codex decide naturally when to invoke its built-in image-generation capability.
- Show uploaded attachments on user messages and generated images inline on agent messages.
- Cache generated images locally for fast history rendering.

## Out of Scope

- Folder uploads.
- A dedicated image-generation mode.
- Direct OpenAI Images API calls.
- Image masks or region editing.
- Artifact galleries, side panels, and version comparison.

## Architecture

The existing flow remains `ChatPanel -> preload IPC -> main process -> AgentSession -> SSH`.

### Composer and Messages

The composer owns a pending `attachments` list with local path, name, MIME/category, size, and upload state. A user message persists text plus attachment metadata. Existing text-only messages remain valid.

### Upload

Before sending a turn, the main process validates every file again, creates a message-specific remote directory, and uploads files through the existing SSH/SFTP transport. Local-host conversations keep local paths and skip SFTP. Failed uploads preserve the draft and expose retryable errors.

### Agent Input

Codex receives image paths through repeated `--image` arguments. Other files are listed in an appended context block with shell-safe remote paths. Claude Code receives all attachments as remote-path context in the prompt for the first version.

### Generated Images

Each turn gets `~/.remote-agent-studio/artifacts/<conversation-id>/<message-id>/` as its dedicated artifact directory. The prompt context tells Codex to place generated image files there and report their paths. `AgentSession` first extracts image artifacts from structured JSON events and tool output, then performs a post-turn scan for new PNG, JPEG, WebP, or GIF files. Paths are normalized and deduplicated.

The main process downloads remote images into the Electron user-data cache and emits `image` messages containing local cache path, remote path, filename, dimensions when available, and file size. The renderer displays an inline thumbnail with a lightbox and file actions.

## Interaction Design

- A paperclip icon opens a multi-file picker; drag and drop uses the same validation.
- Pending files appear as compact removable rows above the textarea.
- Sending is disabled while attachments are uploading.
- User bubbles show attachment chips beneath their text.
- Generated images appear directly beneath the matching agent response.
- Clicking an image opens a full-size modal; secondary actions open the local cache file or reveal the remote path.

## Cleanup and Safety

- Filenames are sanitized and collisions receive deterministic suffixes.
- All shell paths use the existing shell-quoting helper.
- Renderer image URLs are exposed through a narrow main-process conversion instead of enabling arbitrary file access.
- Deleting a conversation attempts to remove its remote attachment directory and local image cache. Cleanup failure does not block conversation deletion.

## Error Handling

- Oversized or unreadable files are rejected before upload.
- Partial upload failures are reported per file and can be retried.
- Agent text and tool errors remain visible when image generation fails.
- Missing cached images show a recoverable placeholder and may be downloaded again from the remote path.
- Unsupported or malformed image events are ignored without breaking text streaming.

## Verification

- Unit tests: file validation, filename sanitization, prompt construction, Codex `--image` arguments, shell escaping, artifact extraction, extension filtering, and deduplication.
- Integration tests with fake SSH transport: upload ordering, local-host bypass, post-turn artifact scan, download-to-cache, and cleanup behavior.
- Renderer tests or focused browser checks: pending attachments, upload errors, inline images, lightbox behavior, text-only history compatibility, and narrow-window layout.
- Build and run the Electron application after implementation.
