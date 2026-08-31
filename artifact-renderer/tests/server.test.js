import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import {
  createArtifactServer,
  MAX_BODY_BYTES,
  MAX_MARKDOWN_BYTES,
  MAX_OUTPUT_BYTES,
} from "../src/server.js";

const TOKEN = "test-renderer-token-with-enough-entropy";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("health is public but rendering requires the exact bearer token", async () => {
  let renderCalls = 0;
  const server = createArtifactServer({
    token: TOKEN,
    render: async () => {
      renderCalls += 1;
      return Buffer.from("%PDF-1.7\n");
    },
  });
  const baseUrl = await listen(server);
  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const missing = await fetch(`${baseUrl}/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "A", markdown: "B" }),
    });
    const wrong = await fetch(`${baseUrl}/render`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "A", markdown: "B" }),
    });
    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(renderCalls, 0);
  } finally {
    await close(server);
  }
});

test("returns PDF bytes with a fixed safe attachment name", async () => {
  const pdf = Buffer.from("%PDF-1.7\nrendered\n%%EOF");
  const server = createArtifactServer({
    token: TOKEN,
    render: async () => pdf,
  });
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/render`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: `Отчёт\r\nX-Evil: yes`,
        markdown: "# Готово",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="document.pdf"',
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
  } finally {
    await close(server);
  }
});

test("rejects oversized bodies and titles before rendering", async () => {
  let renderCalls = 0;
  const server = createArtifactServer({
    token: TOKEN,
    render: async () => {
      renderCalls += 1;
      return Buffer.from("%PDF");
    },
  });
  const baseUrl = await listen(server);
  try {
    const oversized = await fetch(`${baseUrl}/render`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "A",
        markdown: "x".repeat(MAX_MARKDOWN_BYTES + 1),
      }),
    });
    const longTitle = await fetch(`${baseUrl}/render`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "😀".repeat(201), markdown: "ok" }),
    });
    const chunked = await chunkedRenderRequest(
      baseUrl,
      JSON.stringify({
        title: "A",
        markdown: "x".repeat(MAX_BODY_BYTES + 1),
      }),
    );
    assert.equal(oversized.status, 413);
    assert.equal(longTitle.status, 400);
    if (process.versions.bun && chunked.status === 200) {
      // Bun's node:http client synthesizes an empty 200 when the Node-compatible server closes an
      // oversized chunked upload before the client has finished writing it. The renderer itself is
      // shipped on Node (see Dockerfile), where this same request exposes the real 413. Keep the Bun
      // aggregate suite useful by pinning the exact synthetic close and, below, that render was
      // never called.
      assert.equal(chunked.headers.connection, "close");
      assert.equal(chunked.bytes, 0);
    } else {
      assert.equal(chunked.status, 413);
    }
    assert.equal(renderCalls, 0);
  } finally {
    await close(server);
  }
});

test("accepts the public 1 MiB Markdown boundary after JSON escaping", async () => {
  let received;
  const server = createArtifactServer({
    token: TOKEN,
    render: async (job) => {
      received = job;
      return Buffer.from("%PDF-boundary");
    },
  });
  const baseUrl = await listen(server);
  try {
    const markdown = "\n".repeat(MAX_MARKDOWN_BYTES);
    const response = await fetch(`${baseUrl}/render`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Boundary", markdown }),
    });
    assert.equal(response.status, 200);
    assert.equal(received?.markdown.length, MAX_MARKDOWN_BYTES);
  } finally {
    await close(server);
  }
});

test("maps timeout, queue saturation and oversized output to generic errors", async () => {
  const timeoutServer = createArtifactServer({
    token: TOKEN,
    timeoutMs: 20,
    render: async (_job, { signal }) => abortable(signal),
  });
  const timeoutUrl = await listen(timeoutServer);
  try {
    const response = await renderRequest(timeoutUrl);
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: "render timed out" });
  } finally {
    await close(timeoutServer);
  }

  const oversizedServer = createArtifactServer({
    token: TOKEN,
    render: async () => Buffer.alloc(MAX_OUTPUT_BYTES + 1, 0x41),
  });
  const oversizedUrl = await listen(oversizedServer);
  try {
    const response = await renderRequest(oversizedUrl);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "render failed" });
  } finally {
    await close(oversizedServer);
  }

  let release;
  const saturatedServer = createArtifactServer({
    token: TOKEN,
    concurrency: 1,
    maxQueued: 1,
    timeoutMs: 1_000,
    render: () =>
      new Promise((resolve) => {
        release = () => resolve(Buffer.from("%PDF-"));
      }),
  });
  const saturatedUrl = await listen(saturatedServer);
  try {
    const active = renderRequest(saturatedUrl);
    const queued = renderRequest(saturatedUrl);
    await new Promise((resolve) => setImmediate(resolve));
    const refused = await renderRequest(saturatedUrl);
    assert.equal(refused.status, 429);
    release();
    assert.equal((await active).status, 200);
    release();
    assert.equal((await queued).status, 200);
  } finally {
    await close(saturatedServer);
  }
});

function renderRequest(baseUrl) {
  return fetch(`${baseUrl}/render`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "A", markdown: "B" }),
  });
}

function abortable(signal) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function chunkedRenderRequest(baseUrl, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${baseUrl}/render`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (response) => {
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.byteLength;
        });
        response.resume();
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            bytes,
          }),
        );
      },
    );
    request.once("error", reject);
    for (let offset = 0; offset < body.length; offset += 64 * 1024) {
      request.write(body.slice(offset, offset + 64 * 1024));
    }
    request.end();
  });
}
