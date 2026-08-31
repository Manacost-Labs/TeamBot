# Conversation attachments

OpenBot stores files attached to a conversation privately and exposes them only inside the same
authenticated user, Bot, thread, and channel boundary. A client-provided file URL, filename, MIME
type, or inline payload is never treated as storage authority.

## User flow

1. The composer uploads a file to the current channel.
2. The chat message keeps an opaque attachment UUID and display metadata. Private storage paths and
   bytes are not placed in message history.
3. A Bot can list attachments, inspect safe metadata, and read supported text content through the
   built-in `Conversation Attachments` connection.
4. Built-in Bots can inspect an image attached to the latest user turn when it passes the governed
   image boundary described below.

The upload limit is controlled by `ATTACHMENT_MAX_BYTES` and defaults to 25 MiB. Upload acceptance
does not imply that every model or tool can read the file.

## Built-in tools

The attachment connection is read-only. It provides:

- `list_conversation_attachments` for a bounded page of the current conversation's files;
- `read_attachment_metadata` for one file's safe metadata;
- `read_attachment_text` for bounded UTF-8 text extraction.

Every call derives its channel from trusted runtime context. The model cannot choose another user,
Bot, thread, channel, storage key, or filesystem path through tool arguments.

## Image understanding

Only built-in Bots receive model-only image bytes. Remote AG-UI agents receive safe text and opaque
attachment UUIDs, never automatic image bytes or client-provided URLs.

The server authorizes each UUID again and trusts the stored MIME type and size rather than message
metadata. The initial policy accepts PNG, JPEG, and WebP with these limits:

- at most 4 images in one run;
- at most 5 MiB per image;
- at most 10 MiB total;
- one 10-second preparation deadline covering authorization, metadata, and private-blob reads.

Only the latest user turn is enriched. Base64 exists only in the transient provider request; the
stored conversation retains the original opaque UUID. Unsupported, missing, unauthorized, broken,
oversized, or timed-out images are skipped without exposing internal errors or storage details.

## Storage and operations

Attachment metadata is stored in PostgreSQL. Bytes are stored below `ATTACHMENT_STORAGE_DIR`; in
production this must be `/var/lib/openbot/attachments`. Only the API service may mount that volume.
Browser and shell computer services must not share it.

Back up PostgreSQL and the attachment volume from a consistent point in time. Operational setup and
restore notes are in [Deployment](deployment.md) and
[Production operations](production-operations.ru.md).

## Security invariants

- Knowing a UUID is insufficient: user membership, Bot membership, thread mapping, live channel,
  and owner-scoped metadata must all agree.
- Tool and model responses never expose owner IDs, hashes, storage keys, filesystem paths, or signed
  download URLs.
- Client-supplied binary data and URLs are stripped before any built-in or remote model run.
- Image bytes are never forwarded automatically across a remote-agent or handoff trust boundary.
