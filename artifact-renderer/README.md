# TeamBot artifact renderer

Isolated HTTP service that converts a deliberately limited Markdown document into an A4 PDF. It
runs Chromium through Playwright `1.62.1`; every render gets a fresh non-persistent browser context.

## API

`GET /health` is public and returns `{"status":"ok"}`.

`POST /render` requires `Authorization: Bearer $ARTIFACT_RENDERER_TOKEN` and
`Content-Type: application/json`:

```json
{
  "title": "Document title",
  "markdown": "# Heading\n\nBody"
}
```

A successful response is `application/pdf` with a fixed safe download filename. Errors contain only
a stable generic message; request content, credentials and renderer internals are not logged.

## Supported Markdown

- headings and paragraphs;
- ordered and unordered flat lists;
- fenced code blocks and inline code;
- GFM-like pipe tables;
- links using only `http`, `https` or `mailto`.

Raw HTML is always escaped as text. Images, embedded media, nested lists, Markdown extensions and
binary attachments are intentionally unsupported. The HTML and print CSS are self-contained and use
system fonts with Cyrillic fallbacks.

## Limits and isolation

- Markdown: 1 MiB; JSON transport body: 8 MiB so escaped 1 MiB input is not rejected;
- title: 200 Unicode code points;
- generated DOM: 10,000 elements; the supported grammar has a fixed depth below 64;
- PDF: 25 MiB;
- total queue/render deadline: 30 seconds;
- two active renders and 32 waiting jobs.

JavaScript and service workers are disabled. Every browser network request is aborted, permissions
and downloads are disabled, and the context is closed after each job. The container runs as the
non-root `pwuser` from the official Noble Playwright image.

## Run

```sh
npm ci
ARTIFACT_RENDERER_TOKEN='replace-with-a-long-random-secret' npm start
```

The default port is `8080`; set `PORT` to override it. For Docker, keep the Playwright package and
image versions identical. Use Docker's init process and adequate shared memory in deployment, as
recommended for Chromium workloads.
