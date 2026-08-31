import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 500;
const MAX_PAGE_ITEMS = 20_000;
const MAX_DOCUMENT_ITEMS = 200_000;
const MAX_CODE_POINTS = 1_000_000;

class PdfLimitError extends Error {}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > MAX_INPUT_BYTES) throw new PdfLimitError();
    chunks.push(chunk);
  }
  if (size < 5) throw new Error("unreadable");
  return new Uint8Array(Buffer.concat(chunks, size));
}

function textCollector() {
  const parts = [];
  let codePoints = 0;
  let truncated = false;
  return {
    append(fragment) {
      for (const character of fragment) {
        if (codePoints >= MAX_CODE_POINTS) {
          truncated = true;
          return;
        }
        parts.push(character);
        codePoints += 1;
      }
    },
    result() {
      return { text: parts.join(""), truncated };
    },
  };
}

async function extract() {
  const data = await readInput();
  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
    useWasm: false,
    verbosity: 0,
  });
  let document;
  try {
    document = await loadingTask.promise;
    if (document.numPages > MAX_PAGES) throw new PdfLimitError();
    const output = textCollector();
    let documentItems = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        if (content.items.length > MAX_PAGE_ITEMS) throw new PdfLimitError();
        documentItems += content.items.length;
        if (documentItems > MAX_DOCUMENT_ITEMS) throw new PdfLimitError();
        if (pageNumber > 1) output.append("\n");
        let first = true;
        for (const item of content.items) {
          if (!("str" in item) || typeof item.str !== "string") continue;
          if (!first) output.append(" ");
          output.append(item.str);
          first = false;
        }
      } finally {
        page.cleanup();
      }
    }
    return output.result();
  } finally {
    await loadingTask.destroy();
  }
}

try {
  const result = await extract();
  process.stdout.write(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error instanceof PdfLimitError ? "limit" : "unreadable",
    }),
  );
}
