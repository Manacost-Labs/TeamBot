import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { chromium } from "playwright";
import { createPdfRenderer } from "../src/renderer.js";
import { MAX_OUTPUT_BYTES } from "../src/server.js";

test("real Chromium returns a bounded PDF and makes no external request", async () => {
  let externalRequests = 0;
  const external = createServer((_request, response) => {
    externalRequests += 1;
    response.end("should never be fetched");
  });
  await new Promise((resolve) => external.listen(0, "127.0.0.1", resolve));
  const address = external.address();
  assert(address && typeof address === "object");
  const externalUrl = `http://127.0.0.1:${address.port}/leak`;

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  });
  try {
    const render = createPdfRenderer(browser);
    const pdf = await render(
      {
        title: "Кириллический отчёт",
        markdown: [
          "# Проверка PDF",
          "",
          `<img src="${externalUrl}">`,
          `<script>fetch("${externalUrl}")</script>`,
          `[обычная ссылка](${externalUrl})`,
        ].join("\n"),
      },
      { signal: new AbortController().signal },
    );

    assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert(pdf.byteLength > 500);
    assert(pdf.byteLength <= MAX_OUTPUT_BYTES);
    assert.equal(browser.contexts().length, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(externalRequests, 0);
  } finally {
    await browser.close();
    await new Promise((resolve) => external.close(resolve));
  }
});
