import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  extractPdfInWorker,
  PdfTimeoutError,
  PdfUnreadableError,
} from "../src/extract.js";

function pdfWithText(text, { encrypted = false } = {}) {
  const escaped = text
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  if (encrypted) {
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`,
    );
  }
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  const encryption = encrypted
    ? `/Encrypt 6 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>] `
    : "";
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encryption}>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

test("extracts text from a valid PDF in an isolated worker", async () => {
  const result = await extractPdfInWorker(pdfWithText("Hello PDF"));
  assert.deepEqual(result, { text: "Hello PDF", truncated: false });
});

test("returns a stable unreadable error for malformed PDF bytes", async () => {
  await assert.rejects(
    extractPdfInWorker(Buffer.from("%PDF-malformed")),
    PdfUnreadableError,
  );
});

test("returns a stable unreadable error for an encrypted PDF", async () => {
  await assert.rejects(
    extractPdfInWorker(pdfWithText("private", { encrypted: true })),
    PdfUnreadableError,
  );
});

test("does not settle a killed job until the child confirms close", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => true;
  let settled = false;
  const extraction = extractPdfInWorker(Buffer.from("%PDF-test"), {
    timeoutMs: 5,
    spawnProcess: () => child,
  }).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  child.emit("close", null, "SIGKILL");
  await assert.rejects(extraction, PdfTimeoutError);
  assert.equal(settled, true);
});
