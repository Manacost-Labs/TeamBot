import { describe, expect, test } from "bun:test";
import {
  artifactMarkdownUrlTransform,
  documentChipKind,
  safeMarkdownUrl,
} from "./markdown";

describe("safe markdown URLs", () => {
  test("keeps existing web, mail, fragment and relative links", () => {
    expect(safeMarkdownUrl("https://example.test/report")).toBe(
      "https://example.test/report",
    );
    expect(safeMarkdownUrl("http://example.test/report")).toBe(
      "http://example.test/report",
    );
    expect(safeMarkdownUrl("mailto:editor@example.test")).toBe(
      "mailto:editor@example.test",
    );
    expect(safeMarkdownUrl("#summary")).toBe("#summary");
    expect(safeMarkdownUrl("../files/report.md")).toBe("../files/report.md");
  });

  test("refuses active, local and embedded-data schemes", () => {
    expect(safeMarkdownUrl("javascript:alert(1)")).toBeNull();
    expect(
      safeMarkdownUrl("data:text/html,<script>alert(1)</script>"),
    ).toBeNull();
    expect(safeMarkdownUrl("file:///etc/passwd")).toBeNull();
    expect(safeMarkdownUrl("java\nscript:alert(1)")).toBeNull();
  });

  test("allows only web protocols for media sources", () => {
    expect(safeMarkdownUrl("https://images.example.test/a.png", "src")).toBe(
      "https://images.example.test/a.png",
    );
    expect(safeMarkdownUrl("data:image/png;base64,AAAA", "src")).toBeNull();
    expect(safeMarkdownUrl("mailto:image@example.test", "src")).toBeNull();
  });

  test("artifact previews refuse every browser-loaded media source", () => {
    expect(
      artifactMarkdownUrlTransform(
        "https://attacker.example/track",
        "src",
        {} as never,
      ),
    ).toBeNull();
    expect(
      artifactMarkdownUrlTransform(
        "http://127.0.0.1/admin",
        "src",
        {} as never,
      ),
    ).toBeNull();
    expect(
      artifactMarkdownUrlTransform("/private/local.png", "src", {} as never),
    ).toBeNull();
    expect(
      artifactMarkdownUrlTransform("https://example.test", "href", {} as never),
    ).toBe("https://example.test");
  });

  test("recognises document chips only on exact HTTPS hosts", () => {
    expect(
      documentChipKind("https://docs.google.com/document/d/1")?.label,
    ).toBe("Doc");
    expect(
      documentChipKind("https://docs.google.com.evil.test/document/d/1"),
    ).toBeNull();
  });
});
