import {
  ContentLimitError,
  MAX_DOM_DEPTH,
  MAX_DOM_NODES,
  renderMarkdownToHtml,
} from "./markdown.js";

export function createPdfRenderer(browser) {
  if (!browser || typeof browser.newContext !== "function") {
    throw new TypeError("a Playwright browser is required");
  }

  return async function renderPdf(job, { signal }) {
    if (signal.aborted) throw signal.reason;
    const html = renderMarkdownToHtml(job);
    let context;
    const closeOnAbort = () => {
      void context?.close().catch(() => undefined);
    };
    signal.addEventListener("abort", closeOnAbort, { once: true });
    try {
      context = await browser.newContext({
        javaScriptEnabled: false,
        serviceWorkers: "block",
        acceptDownloads: false,
        permissions: [],
      });
      if (signal.aborted) throw signal.reason;
      await context.route("**/*", (route) => route.abort("blockedbyclient"));
      const page = await context.newPage();
      await page.emulateMedia({ media: "print" });
      await page.setContent(html, { waitUntil: "load" });
      const structure = await page.locator("*").evaluateAll((elements) => {
        let maxDepth = 0;
        for (const element of elements) {
          let depth = 1;
          let parent = element.parentElement;
          while (parent) {
            depth += 1;
            parent = parent.parentElement;
          }
          maxDepth = Math.max(maxDepth, depth);
        }
        return { nodes: elements.length, maxDepth };
      });
      if (
        structure.nodes > MAX_DOM_NODES ||
        structure.maxDepth > MAX_DOM_DEPTH
      ) {
        throw new ContentLimitError();
      }
      if (signal.aborted) throw signal.reason;
      return await page.pdf({
        format: "A4",
        preferCSSPageSize: true,
        printBackground: true,
        tagged: true,
      });
    } finally {
      signal.removeEventListener("abort", closeOnAbort);
      await context?.close().catch(() => undefined);
    }
  };
}
