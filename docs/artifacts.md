# Generated artifacts

OpenBot can turn a Bot's result into a private file card in the current conversation. The governed
contract supports Markdown, text, JSON, CSV, SVG, HTML and rendered PDF. The card is durable conversation state: it
survives streaming reconnects, history replay and route changes, and offers an authenticated preview
and download without revealing a filesystem path or storage key.

## User flow

A Bot granted `artifacts/create_artifact` calls `create_artifact` with a title, filename, MIME type
and inline content. The filename extension must exactly match its MIME family:

| Output | MIME type | Extension | Input and preview |
| --- | --- | --- | --- |
| Markdown | `text/markdown` | `.md` | Markdown; rendered with external media blocked |
| Text | `text/plain` | `.txt` | inert source text |
| JSON | `application/json` | `.json` | valid, bounded JSON; inert source text |
| CSV | `text/csv` | `.csv` | inert source text |
| SVG | `image/svg+xml` | `.svg` | parsed, passive SVG only; inert source text |
| HTML | `text/html` | `.html` | generated artifacts only; inert source text |
| PDF | `application/pdf` | `.pdf` | Markdown rendered by the isolated PDF service |

A successful tool result is the versioned `openbot.artifact.v1` envelope. The frontend recognises
that envelope only for the exact first-party tool name, then reads authoritative metadata through
the signed-in user's channel boundary before drawing the card. Inline content is limited to 1 MiB
of UTF-8. JSON additionally has bounded depth and node count before any export lease is claimed.

`workspacePath` is reserved in the tool schema but currently returns `CAPABILITY_UNAVAILABLE`.
Managed workspaces are deliberately not exposed through the attachment service. A future workspace
export must add its own governed, bounded reader rather than handing model paths to this API.

## Authorization and storage

Artifact creation requires all of the following:

1. a trusted run assertion supplies the actor, Bot, run and thread identifiers;
2. the actor is a live member of the thread's channel;
3. the Bot is permitted in that channel;
4. the Bot holds the artifact tool grant;
5. the action policy permits the write.

The result is stored through the normal attachment lifecycle with `source=agent_generated` and an
opaque attachment ID. Only the signed-in channel member can read metadata or bytes. Preview refuses
ordinary user uploads and every MIME type outside the artifact contract. Responses use `private,
no-store`, `nosniff`, a restrictive CSP and same-origin resource policy.

HTML is intentionally not rendered: its preview response is `text/plain` and React inserts the
bytes as a text node. SVG receives the existing strict XML/SVG validation that rejects scripts,
event handlers, `foreignObject`, external or data references, and CSS resource loading; its preview
is still source text. The same inert source path is used for text, JSON and CSV. Preview is fetched
only after the user clicks **Предпросмотр**. Downloads always use `Content-Disposition: attachment`
with `nosniff` and a sandboxing CSP, so the application never executes artifact markup. Downloaded
files remain untrusted data if a user later opens them in another program.

One logical request is keyed by actor, channel, Bot, run and a content fingerprint. A database-clock
lease prevents simultaneous replicas from publishing duplicates. A retry returns the already-ready
attachment; an expired worker can recover an uploaded orphan by its private artifact message ID.
The fingerprint is stored, but the artifact content is not stored in the idempotency table.

## PDF renderer

PDF conversion is a separate service under `artifact-renderer/`. It accepts only authenticated
`POST /render` requests from the OpenBot server. Every job receives a fresh non-persistent Chromium
context with JavaScript and service workers disabled; all browser network requests are aborted.
Raw HTML is escaped, links are limited to safe protocols, and the Markdown grammar, request size,
DOM nodes/depth, queue, deadline and PDF output size are bounded.

Production Compose connects the renderer and OpenBot through the internal `artifact-render` network.
The renderer receives no attachment volume, workspace, browser profile, OAuth credential, model key
or public port. Its filesystem is read-only with a bounded temporary filesystem. OpenBot validates
the response content type, byte length and `%PDF-` signature before storing it.

## Production setup

Generate a dedicated secret in `.env`:

```sh
openssl rand -base64 48
```

Save the result as `ARTIFACT_RENDERER_TOKEN`. Do not paste the value into Compose, Git, chat or a
tenant package. `docker-compose.production.yml` supplies the internal URL automatically. For local
development, start the renderer separately and set both:

```text
ARTIFACT_RENDERER_URL=http://localhost:8080
ARTIFACT_RENDERER_TOKEN=<dedicated random value of at least 32 characters>
```

If only one variable is set, or the token is shorter than 32 characters, the API server refuses to
start. If neither is set, every non-PDF artifact remains available and PDF creation reports that
the capability is not configured.

## Operations and troubleshooting

- **PDF capability unavailable:** check that both renderer variables exist and the renderer health
  check is green. Do not fall back to asking the model for binary PDF data.
- **File card unavailable:** verify the attachment still exists and that the current user still
  belongs to the channel. Metadata and preview deliberately use the same uniform unavailable state.
- **Render queue full or timed out:** retry the logical tool call. The idempotency lease prevents a
  successful earlier attempt from becoming a duplicate.
- **Renderer fails after deploy:** confirm the Playwright package and container image carry the same
  pinned version. Keep the renderer off the public network and never mount customer storage into it.

Back up the artifact bytes with the attachment volume and PostgreSQL metadata. See
[Attachments](attachments.md) for lifecycle details and [Configuration](configuration.md) for the
storage and renderer variables.
