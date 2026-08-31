import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { PdfUnreadableError } from "../src/extract.js";
import { createPdfExtractorServer, MAX_INPUT_BYTES } from "../src/server.js";

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

function request(baseUrl, body = Buffer.from("%PDF-test")) {
  return fetch(`${baseUrl}/extract`, {
    method: "POST",
    headers: { "content-type": "application/pdf" },
    body,
  });
}

test("accepts only raw PDF bytes and returns content-safe JSON", async () => {
  let received;
  const server = createPdfExtractorServer({
    extract: async (pdf) => {
      received = pdf;
      return { text: "Привет", truncated: false };
    },
  });
  const baseUrl = await listen(server);
  try {
    assert.deepEqual(await (await fetch(`${baseUrl}/health`)).json(), {
      status: "ok",
    });
    const response = await request(baseUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      text: "Привет",
      truncated: false,
    });
    assert.equal(received.toString(), "%PDF-test");
  } finally {
    await close(server);
  }
});

test("rejects malformed, encrypted/unreadable and oversized inputs generically", async () => {
  const server = createPdfExtractorServer({
    extract: async () => {
      throw new PdfUnreadableError();
    },
  });
  const baseUrl = await listen(server);
  try {
    assert.equal((await request(baseUrl, Buffer.from("not-pdf"))).status, 400);
    assert.equal((await request(baseUrl)).status, 422);
    const oversizedPdf = Buffer.alloc(MAX_INPUT_BYTES + 1);
    oversizedPdf.write("%PDF-");
    const oversized = await request(baseUrl, oversizedPdf);
    assert.equal(oversized.status, 413);
  } finally {
    await close(server);
  }
});

test("bounds active work, queue length and outer timeout without logging content", async () => {
  const releases = [];
  const logged = [];
  const originalError = console.error;
  console.error = (...values) => logged.push(values.join(" "));
  const server = createPdfExtractorServer({
    concurrency: 1,
    maxQueued: 1,
    timeoutMs: 30,
    extract: (_pdf, { signal }) =>
      new Promise((resolve, reject) => {
        releases.push(() => resolve({ text: "ok", truncated: false }));
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  const baseUrl = await listen(server);
  try {
    const active = request(baseUrl, Buffer.from("%PDF-private-active"));
    const queued = request(baseUrl, Buffer.from("%PDF-private-queued"));
    await new Promise((resolve) => setImmediate(resolve));
    const refused = await request(baseUrl, Buffer.from("%PDF-private-refused"));
    assert.equal(refused.status, 429);
    assert.equal((await active).status, 504);
    assert.equal((await queued).status, 504);
    assert.equal(logged.join(" ").includes("private"), false);
  } finally {
    for (const release of releases) release();
    console.error = originalError;
    await close(server);
  }
});

test("destroys a stalled upload at its deadline and releases admission", async () => {
  const server = createPdfExtractorServer({
    concurrency: 1,
    maxQueued: 0,
    timeoutMs: 30,
    extract: async () => ({ text: "ok", truncated: false }),
  });
  const baseUrl = await listen(server);
  try {
    const stalledClosed = new Promise((resolve) => {
      const stalled = httpRequest(`${baseUrl}/extract`, {
        method: "POST",
        headers: { "content-type": "application/pdf" },
      });
      stalled.on("error", resolve);
      stalled.on("close", resolve);
      stalled.write("%PDF-");
    });
    await stalledClosed;

    const recovered = await request(baseUrl);
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), {
      text: "ok",
      truncated: false,
    });
  } finally {
    await close(server);
  }
});
