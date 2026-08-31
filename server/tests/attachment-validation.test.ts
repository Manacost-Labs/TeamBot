import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  AttachmentValidationError,
  type AttachmentValidationErrorCode,
  validateStoredAttachment,
} from "../src/attachments/validation";

const MIME = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  json: "application/json",
  markdown: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  text: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  yaml: "application/yaml",
} as const;

const roots: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function validate(
  name: string,
  claimedMimeType: string,
  content: Uint8Array | string,
  source?: "agent_generated" | "user_upload",
) {
  const root = await mkdtemp(join(tmpdir(), "teambot-validation-"));
  roots.push(root);
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  const internalPath = join(root, randomUUID());
  await writeFile(internalPath, bytes);

  return validateStoredAttachment({
    name,
    claimedMimeType,
    source,
    openStream: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    withFilePath: async <Value>(
      inspect: (path: string) => Promise<Value>,
    ): Promise<Value> => inspect(internalPath),
  });
}

async function expectValidationError(
  promise: Promise<unknown>,
  code: AttachmentValidationErrorCode,
): Promise<AttachmentValidationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AttachmentValidationError);
    const validationError = error as AttachmentValidationError;
    expect(validationError.code).toBe(code);
    return validationError;
  }
  throw new Error(`Expected attachment validation error ${code}`);
}

describe("attachment metadata validation", () => {
  test("normalizes Unicode names and MIME while returning no content or path", async () => {
    const result = await validate(
      "  cafe\u0301.TXT  ",
      " TEXT/PLAIN ",
      "strict UTF-8 text",
    );

    expect(result).toEqual({ name: "café.TXT", mimeType: MIME.text });
    expect(Object.keys(result)).toEqual(["name", "mimeType"]);
  });

  test("accepts exactly 255 Unicode code points and rejects 256", async () => {
    const longest = `${"😀".repeat(251)}.txt`;
    expect([...longest]).toHaveLength(255);
    await expect(validate(longest, MIME.text, "ok")).resolves.toEqual({
      name: longest,
      mimeType: MIME.text,
    });

    const tooLong = `${"😀".repeat(252)}.txt`;
    await expectValidationError(
      validate(tooLong, MIME.text, "no"),
      "invalid_name",
    );
  });

  test.each([
    "",
    "   ",
    ".",
    "..",
    ".hidden.txt",
    "bad\0.txt",
    "bad\u0001.txt",
    "bad\r\nname.txt",
    "/absolute.txt",
    "C:\\absolute.txt",
    "../escape.txt",
    "folder/file.txt",
    "folder\\file.txt",
  ])("rejects an unsafe filename: %p", async (name) => {
    await expectValidationError(
      validate(name, MIME.text, "no"),
      "invalid_name",
    );
  });

  test.each([
    ["image.png", MIME.png],
    ["photo.jpg", MIME.jpeg],
    ["photo.jpeg", MIME.jpeg],
    ["image.webp", MIME.webp],
    ["image.gif", MIME.gif],
    ["drawing.svg", MIME.svg],
    ["note.txt", MIME.text],
    ["readme.md", MIME.markdown],
    ["data.json", MIME.json],
    ["rows.csv", MIME.csv],
    ["data.xml", MIME.xml],
    ["config.yaml", MIME.yaml],
    ["config.yml", MIME.yaml],
    ["paper.pdf", MIME.pdf],
    ["report.docx", MIME.docx],
    ["sheet.xlsx", MIME.xlsx],
  ])("keeps the exact extension/MIME pair for %s", async (name, mimeType) => {
    const validContent = contentFor(name);
    await expect(validate(name, mimeType, validContent)).resolves.toEqual({
      name,
      mimeType,
    });
  });

  test("rejects unsupported extensions and a claimed MIME mismatch", async () => {
    await expectValidationError(
      validate("program.exe", "application/octet-stream", "MZ"),
      "unsupported_type",
    );
    await expectValidationError(
      validate("image.png", MIME.jpeg, png()),
      "mime_mismatch",
    );
    await expectValidationError(
      validate("image.png", `${MIME.png}; charset=binary`, png()),
      "mime_mismatch",
    );
  });

  test("reserves HTML for trusted generated artifacts", async () => {
    const html =
      '<!doctype html><script src="https://attacker.test/x.js"></script>';
    await expectValidationError(
      validate("page.html", MIME.html, html, "user_upload"),
      "unsupported_type",
    );
    await expect(
      validate("page.html", MIME.html, html, "agent_generated"),
    ).resolves.toEqual({ name: "page.html", mimeType: MIME.html });
  });
});

describe("attachment content validation", () => {
  test.each([
    ["image.png", MIME.png, png()],
    ["photo.jpg", MIME.jpeg, jpeg()],
    ["photo.jpeg", MIME.jpeg, jpeg()],
    ["image.gif", MIME.gif, encoder.encode("GIF89a")],
    ["image.webp", MIME.webp, webp()],
    ["paper.pdf", MIME.pdf, encoder.encode("%PDF-1.7\n")],
  ])("accepts the expected magic bytes for %s", async (name, mime, bytes) => {
    await expect(validate(name, mime, bytes)).resolves.toEqual({
      name,
      mimeType: mime,
    });
  });

  test.each([
    ["image.png", MIME.png],
    ["photo.jpg", MIME.jpeg],
    ["image.gif", MIME.gif],
    ["image.webp", MIME.webp],
    ["paper.pdf", MIME.pdf],
  ])("rejects spoofed magic bytes for %s", async (name, mime) => {
    await expectValidationError(
      validate(name, mime, encoder.encode("not the claimed format")),
      "invalid_content",
    );
  });

  test.each([
    ["note.txt", MIME.text, "hello"],
    ["readme.md", MIME.markdown, "# hello"],
    ["rows.csv", MIME.csv, "name,value\nhello,1"],
    ["config.yaml", MIME.yaml, "safe: true"],
    ["config.yml", MIME.yaml, "safe: true"],
  ])("accepts strict UTF-8 text for %s", async (name, mime, text) => {
    await expect(validate(name, mime, text)).resolves.toEqual({
      name,
      mimeType: mime,
    });
  });

  test("rejects malformed UTF-8 without echoing its content", async () => {
    const error = await expectValidationError(
      validate("secret.txt", MIME.text, new Uint8Array([0x73, 0x65, 0x80])),
      "invalid_content",
    );
    expect(error.message).not.toContain("secret");
  });

  test("parses JSON instead of trusting its extension", async () => {
    await expect(
      validate("data.json", MIME.json, '{"safe":true}'),
    ).resolves.toEqual({ name: "data.json", mimeType: MIME.json });
    await expectValidationError(
      validate("data.json", MIME.json, '{"secret":"do not echo"'),
      "invalid_content",
    );
  });

  test("accepts well-formed XML and rejects DTD, ENTITY and malformed markup", async () => {
    await expect(
      validate("data.xml", MIME.xml, "<root><item>safe</item></root>"),
    ).resolves.toEqual({ name: "data.xml", mimeType: MIME.xml });

    for (const xml of [
      '<!DOCTYPE root SYSTEM "file:///etc/passwd"><root/>',
      '<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root>&xxe;</root>',
      "<root><unclosed></root>",
    ]) {
      await expectValidationError(
        validate("data.xml", MIME.xml, xml),
        "unsafe_content",
      );
    }
  });
});

describe("SVG validation", () => {
  const safeSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="10" height="10"/></svg>';

  test("accepts a small parsed SVG with internal fragment references", async () => {
    await expect(validate("drawing.svg", MIME.svg, safeSvg)).resolves.toEqual({
      name: "drawing.svg",
      mimeType: MIME.svg,
    });
  });

  test.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://attacker.test/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AA=="/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#x73;cript:alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://attacker.test/a.svg)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://attacker.test/x.css";</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>&#x40;&#x69;&#x6d;&#x70;&#x6f;&#x72;&#x74; "&#x68;ttps://attacker.test/x.css";</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@\\69mport "https://attacker.test/x.css";</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:u\\72l(\\68ttps://attacker.test/a.svg)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>/\\2a @import "https://attacker.test/x.css"; */</style></svg>',
  ])("rejects executable or external SVG content", async (svg) => {
    await expectValidationError(
      validate("drawing.svg", MIME.svg, svg),
      "unsafe_content",
    );
  });

  test.each([
    [
      "CDATA in @import",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@im<![CDATA[port "https://attacker.test/x.css"]]></style></svg>',
    ],
    [
      "CDATA in url()",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:u<![CDATA[rl(https://attacker.test/a.svg)]]>}</style></svg>',
    ],
    [
      "an XML comment in @import",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@im<!-- boundary -->port "https://attacker.test/x.css"</style></svg>',
    ],
    [
      "an XML comment in url()",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:u<!-- boundary -->rl(https://attacker.test/a.svg)}</style></svg>',
    ],
  ])("rejects unsafe SVG style content split by %s", async (_boundary, svg) => {
    await expectValidationError(
      validate("drawing.svg", MIME.svg, svg),
      "unsafe_content",
    );
  });

  test.each([
    [
      "literal image-set",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{background:image-set("https://attacker.test/a.png" 1x)}</style></svg>',
    ],
    [
      "mixed-case image-set and a network path",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{background:ImAgE-SeT("//attacker.test/a.png" 1x)}</style></svg>',
    ],
    [
      "escaped image-set",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{background:ima\\67 e-set("https://attacker.test/a.png" 1x)}</style></svg>',
    ],
    [
      "comment-split image-set",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{background:image-/**/set("https://attacker.test/a.png" 1x)}</style></svg>',
    ],
  ])("rejects external SVG CSS hidden in %s", async (_variant, svg) => {
    await expectValidationError(
      validate("drawing.svg", MIME.svg, svg),
      "unsafe_content",
    );
  });

  test("keeps internal fragment CSS URLs allowed", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><style>rect{fill:url("#g")}</style><rect/></svg>';
    await expect(validate("drawing.svg", MIME.svg, svg)).resolves.toEqual({
      name: "drawing.svg",
      mimeType: MIME.svg,
    });
  });

  test.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@im<?xml?>port "https://attacker.test/x.css"</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style><g/></style></svg>',
  ])("fails closed on markup inside an SVG style element", async (svg) => {
    await expectValidationError(
      validate("drawing.svg", MIME.svg, svg),
      "unsafe_content",
    );
  });

  test("fails closed on malformed SVG and excessive element complexity", async () => {
    await expectValidationError(
      validate("drawing.svg", MIME.svg, "<svg><g></svg>"),
      "unsafe_content",
    );
    const complex = `<svg xmlns="http://www.w3.org/2000/svg">${"<g/>".repeat(10_001)}</svg>`;
    await expectValidationError(
      validate("drawing.svg", MIME.svg, complex),
      "content_too_complex",
    );
  });
});

describe("OOXML validation", () => {
  test.each([
    ["report.docx", MIME.docx, validDocx()],
    ["sheet.xlsx", MIME.xlsx, validXlsx()],
  ])(
    "reads a valid %s lazily without returning archive content",
    async (name, mime, zip) => {
      const result = await validate(name, mime, zip);
      expect(result).toEqual({ name, mimeType: mime });
      expect(Object.keys(result)).toEqual(["name", "mimeType"]);
    },
  );

  test("rejects a non-ZIP file with an OOXML extension", async () => {
    await expectValidationError(
      validate("report.docx", MIME.docx, "PK is not enough"),
      "invalid_archive",
    );
  });

  test("requires Content_Types and the extension-specific package tree", async () => {
    await expectValidationError(
      validate(
        "report.docx",
        MIME.docx,
        zip([{ name: "word/document.xml", data: "<document/>" }]),
      ),
      "invalid_archive",
    );
    await expectValidationError(
      validate(
        "report.docx",
        MIME.docx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("docx") },
          { name: "xl/workbook.xml", data: "<workbook/>" },
        ]),
      ),
      "invalid_archive",
    );
  });

  test("rejects a declared main OOXML part that is absent from the archive", async () => {
    await expectValidationError(
      validate(
        "report.docx",
        MIME.docx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("docx") },
          { name: "word/other.xml", data: "<not-the-declared-document/>" },
        ]),
      ),
      "invalid_archive",
    );
  });

  test("rejects a local ZIP filename that differs from its central directory entry", async () => {
    await expectValidationError(
      validate(
        "report.docx",
        MIME.docx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("docx") },
          {
            name: "word/document.xml",
            localName: "../../outside.xml",
            data: "<document/>",
          },
        ]),
      ),
      "unsafe_archive",
    );
  });

  test("measures actual OOXML inflation instead of trusting declared sizes", async () => {
    await expectValidationError(
      validate(
        "report.docx",
        MIME.docx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("docx") },
          {
            name: "word/document.xml",
            data: "A".repeat(2_000_000),
            deflate: true,
            declaredUncompressedSize: 100_000,
          },
        ]),
      ),
      "archive_too_complex",
    );
  });

  test("rejects external OOXML relationships", async () => {
    await expectValidationError(
      validate(
        "report.docx",
        MIME.docx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("docx") },
          { name: "word/document.xml", data: "<document/>" },
          {
            name: "word/_rels/document.xml.rels",
            data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://attacker.test/template.dotm" TargetMode="External"/></Relationships>',
          },
        ]),
      ),
      "unsafe_archive",
    );
  });

  test.each([
    ["report.docx", MIME.docx, "word/embeddings/object1.bin"],
    ["report.docx", MIME.docx, "word/activeX/activeX1.bin"],
    ["sheet.xlsx", MIME.xlsx, "xl/externalLinks/externalLink1.xml"],
  ])(
    "rejects active OOXML package part in %s (%s): %s",
    async (name, mime, activePart) => {
      const kind = name.endsWith(".docx") ? "docx" : "xlsx";
      const mainPart =
        kind === "docx" ? "word/document.xml" : "xl/workbook.xml";
      await expectValidationError(
        validate(
          name,
          mime,
          zip([
            { name: "[Content_Types].xml", data: contentTypes(kind) },
            { name: mainPart, data: "<document/>" },
            { name: activePart, data: "active payload" },
          ]),
        ),
        "unsafe_archive",
      );
    },
  );

  test("rejects active OOXML content types even under an unremarkable path", async () => {
    const types = contentTypes("docx").replace(
      "</Types>",
      '<Override PartName="/word/media/object.bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/></Types>',
    );
    await expectValidationError(
      validate(
        "report.docx",
        MIME.docx,
        zip([
          { name: "[Content_Types].xml", data: types },
          { name: "word/document.xml", data: "<document/>" },
          { name: "word/media/object.bin", data: "active payload" },
        ]),
      ),
      "unsafe_archive",
    );
  });

  test("rejects DDE field instructions split across OOXML text nodes", async () => {
    await expectValidationError(
      validate(
        "report.docx",
        MIME.docx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("docx") },
          {
            name: "word/document.xml",
            data: '<w:document xmlns:w="urn:w"><w:instrText>D</w:instrText><w:instrText>D&#x45;AUTO cmd.exe /c calc</w:instrText></w:document>',
          },
        ]),
      ),
      "unsafe_archive",
    );
  });

  test.each([
    ["plain", "<worksheet><f>=cmd|' /C calc'!A0</f></worksheet>"],
    [
      "without a serialized equals sign",
      "<worksheet><f>cmd|' /C calc'!A0</f></worksheet>",
    ],
    [
      "quoted mixed-case with whitespace",
      "<worksheet><f> = 'CmD' | &quot;/C calc&quot; ! 'A0' </f></worksheet>",
    ],
    [
      "single-quoted service and topic",
      "<worksheet><f>='CmD| /C calc'!A0</f></worksheet>",
    ],
    [
      "split by CDATA",
      "<worksheet><f>=c<![CDATA[Md|' /C]]> calc'!A0</f></worksheet>",
    ],
    [
      "split by an XML comment",
      "<worksheet><f>=CM<!-- boundary -->D|' /C calc'!A0</f></worksheet>",
    ],
  ])("rejects %s XLSX DDE formulas", async (_variant, worksheet) => {
    await expectValidationError(
      validate(
        "sheet.xlsx",
        MIME.xlsx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("xlsx") },
          { name: "xl/workbook.xml", data: "<workbook/>" },
          { name: "xl/worksheets/sheet1.xml", data: worksheet },
        ]),
      ),
      "unsafe_archive",
    );
  });

  test.each([
    ["workbook before worksheet", "Sales|2026", "='Sales|2026'!A1", false],
    ["workbook after worksheet", "Sales|2026", "='Sales|2026'!A1", true],
    [
      "a doubled apostrophe in the formula",
      "O'Brien|2026",
      "='O''Brien|2026'!A1",
      false,
    ],
  ])(
    "accepts a quoted local sheet reference with %s",
    async (_variant, sheetName, formula, worksheetFirst) => {
      const workbook = `<workbook><sheets><sheet name="${sheetName}"/></sheets></workbook>`;
      const worksheet = `<worksheet><f>${formula}</f></worksheet>`;
      const workbookEntry = { name: "xl/workbook.xml", data: workbook };
      const worksheetEntry = {
        name: "xl/worksheets/sheet1.xml",
        data: worksheet,
      };
      await expect(
        validate(
          "sheet.xlsx",
          MIME.xlsx,
          zip([
            { name: "[Content_Types].xml", data: contentTypes("xlsx") },
            ...(worksheetFirst
              ? [worksheetEntry, workbookEntry]
              : [workbookEntry, worksheetEntry]),
          ]),
        ),
      ).resolves.toEqual({ name: "sheet.xlsx", mimeType: MIME.xlsx });
    },
  );

  test("accepts multiple real quoted sheet references in one formula", async () => {
    await expect(
      validate(
        "sheet.xlsx",
        MIME.xlsx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("xlsx") },
          {
            name: "xl/workbook.xml",
            data: '<workbook><sheets><sheet name="Sales|2026"/><sheet name="Costs|2026"/></sheets></workbook>',
          },
          {
            name: "xl/worksheets/sheet1.xml",
            data: "<worksheet><f>='Sales|2026'!A1+'Costs|2026'!B2</f></worksheet>",
          },
        ]),
      ),
    ).resolves.toEqual({ name: "sheet.xlsx", mimeType: MIME.xlsx });
  });

  test("ignores pipe syntax in a string while collecting a real sheet reference", async () => {
    await expect(
      validate(
        "sheet.xlsx",
        MIME.xlsx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("xlsx") },
          {
            name: "xl/workbook.xml",
            data: '<workbook><sheets><sheet name="Sales|2026"/></sheets></workbook>',
          },
          {
            name: "xl/worksheets/sheet1.xml",
            data: "<worksheet><f>=\"safe|text!only\"&amp;'Sales|2026'!A1</f></worksheet>",
          },
        ]),
      ),
    ).resolves.toEqual({ name: "sheet.xlsx", mimeType: MIME.xlsx });
  });

  test.each([
    ["a nonmatching sheet", "Sales|2025", "='Sales|2026'!A1"],
    ["an invalid declared sheet name", "cmd|/C calc", "='cmd|/C calc'!A0"],
    ["a second DDE-shaped tail", "Sales|2026", "='Sales|2026'!A1+cmd|topic!A0"],
    [
      "an overlong ambiguous head",
      `${"a".repeat(30)}|x`,
      `='${"a".repeat(30)}|x'!A1`,
    ],
  ])(
    "rejects an ambiguous XLSX reference with %s",
    async (_variant, sheetName, formula) => {
      await expectValidationError(
        validate(
          "sheet.xlsx",
          MIME.xlsx,
          zip([
            { name: "[Content_Types].xml", data: contentTypes("xlsx") },
            {
              name: "xl/workbook.xml",
              data: `<workbook><sheets><sheet name="${sheetName}"/></sheets></workbook>`,
            },
            {
              name: "xl/worksheets/sheet1.xml",
              data: `<worksheet><f>${formula}</f></worksheet>`,
            },
          ]),
        ),
        "unsafe_archive",
      );
    },
  );

  test("bounds the number of pending ambiguous XLSX references", async () => {
    const formula = "<f>='Sales|2026'!A1</f>";
    await expectValidationError(
      validate(
        "sheet.xlsx",
        MIME.xlsx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("xlsx") },
          {
            name: "xl/worksheets/sheet1.xml",
            data: `<worksheet>${formula.repeat(1_025)}</worksheet>`,
          },
          {
            name: "xl/workbook.xml",
            data: '<workbook><sheets><sheet name="Sales|2026"/></sheets></workbook>',
          },
        ]),
      ),
      "archive_too_complex",
    );
  });

  test("bounds multiple ambiguous references inside one XLSX formula", async () => {
    const references = Array.from(
      { length: 1_025 },
      () => "'Sales|2026'!A1",
    ).join("+");
    await expectValidationError(
      validate(
        "sheet.xlsx",
        MIME.xlsx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("xlsx") },
          {
            name: "xl/workbook.xml",
            data: '<workbook><sheets><sheet name="Sales|2026"/></sheets></workbook>',
          },
          {
            name: "xl/worksheets/sheet1.xml",
            data: `<worksheet><f>=${references}</f></worksheet>`,
          },
        ]),
      ),
      "archive_too_complex",
    );
  });

  test.each([
    ["one of multiple undeclared heads", "='Sales|2026'!A1+'Missing|2026'!B2"],
    ["an unterminated quoted head", "='Sales|2026!A1"],
  ])("rejects an XLSX formula with %s", async (_variant, formula) => {
    await expectValidationError(
      validate(
        "sheet.xlsx",
        MIME.xlsx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("xlsx") },
          {
            name: "xl/workbook.xml",
            data: '<workbook><sheets><sheet name="Sales|2026"/></sheets></workbook>',
          },
          {
            name: "xl/worksheets/sheet1.xml",
            data: `<worksheet><f>${formula}</f></worksheet>`,
          },
        ]),
      ),
      "unsafe_archive",
    );
  });

  test("does not trust a sheet name outside the workbook sheets declaration", async () => {
    await expectValidationError(
      validate(
        "sheet.xlsx",
        MIME.xlsx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("xlsx") },
          {
            name: "xl/workbook.xml",
            data: '<workbook><metadata><sheet name="Sales|2026"/></metadata></workbook>',
          },
          {
            name: "xl/worksheets/sheet1.xml",
            data: "<worksheet><f>='Sales|2026'!A1</f></worksheet>",
          },
        ]),
      ),
      "unsafe_archive",
    );
  });

  test.each([
    ["a DDE keyword", '="DDE"'],
    ["DDE delimiters", '="safe|text!only"'],
    ["doubled quote escapes", '="safe ""DDE|topic!A0"" text"'],
  ])(
    "does not inspect %s inside an XLSX string literal",
    async (_variant, formula) => {
      await expect(
        validate(
          "sheet.xlsx",
          MIME.xlsx,
          zip([
            { name: "[Content_Types].xml", data: contentTypes("xlsx") },
            { name: "xl/workbook.xml", data: "<workbook/>" },
            {
              name: "xl/worksheets/sheet1.xml",
              data: `<worksheet><f>${formula}</f></worksheet>`,
            },
          ]),
        ),
      ).resolves.toEqual({ name: "sheet.xlsx", mimeType: MIME.xlsx });
    },
  );

  test.each([
    ["an unterminated string", '="cmd|topic!A0'],
    ["DDE outside a closed string", '="safe"&amp;cmd|topic!A0'],
  ])("rejects an XLSX formula with %s", async (_variant, formula) => {
    await expectValidationError(
      validate(
        "sheet.xlsx",
        MIME.xlsx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("xlsx") },
          { name: "xl/workbook.xml", data: "<workbook/>" },
          {
            name: "xl/worksheets/sheet1.xml",
            data: `<worksheet><f>${formula}</f></worksheet>`,
          },
        ]),
      ),
      "unsafe_archive",
    );
  });

  test("checks actual CRC32 instead of accepting central-directory metadata", async () => {
    await expectValidationError(
      validate(
        "report.docx",
        MIME.docx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("docx") },
          {
            name: "word/document.xml",
            data: "<document/>",
            declaredCrc32: 0,
          },
        ]),
      ),
      "invalid_archive",
    );
  });

  test("accepts valid ZIP data descriptors and rejects missing or inconsistent ones", async () => {
    await expect(
      validate(
        "report.docx",
        MIME.docx,
        zip([
          {
            name: "[Content_Types].xml",
            data: contentTypes("docx"),
            dataDescriptor: "valid",
          },
          {
            name: "word/document.xml",
            data: "<document/>",
            dataDescriptor: "valid",
          },
        ]),
      ),
    ).resolves.toEqual({ name: "report.docx", mimeType: MIME.docx });

    for (const dataDescriptor of ["missing", "invalid"] as const) {
      await expectValidationError(
        validate(
          "report.docx",
          MIME.docx,
          zip([
            { name: "[Content_Types].xml", data: contentTypes("docx") },
            {
              name: "word/document.xml",
              data: "<document/>",
              dataDescriptor,
            },
          ]),
        ),
        "unsafe_archive",
      );
    }
  });

  test.each([
    [
      "traversal",
      [
        { name: "[Content_Types].xml", data: contentTypes("docx") },
        { name: "../word/document.xml", data: "<document/>" },
      ],
    ],
    [
      "encrypted entries",
      [
        { name: "[Content_Types].xml", data: contentTypes("docx") },
        { name: "word/document.xml", data: "<document/>", encrypted: true },
      ],
    ],
    [
      "VBA macros",
      [
        { name: "[Content_Types].xml", data: contentTypes("docx") },
        { name: "word/document.xml", data: "<document/>" },
        { name: "word/vbaProject.bin", data: "macro" },
      ],
    ],
  ] satisfies [string, ZipEntry[]][])(
    "rejects OOXML %s",
    async (_case, entries) => {
      await expectValidationError(
        validate("report.docx", MIME.docx, zip(entries)),
        "unsafe_archive",
      );
    },
  );

  test("rejects excessive entries and high compression-ratio bombs", async () => {
    const excessive = Array.from({ length: 1_001 }, (_, index) => ({
      name: `word/items/${index}.xml`,
      data: "<x/>",
    }));
    await expectValidationError(
      validate(
        "report.docx",
        MIME.docx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("docx") },
          ...excessive,
        ]),
      ),
      "archive_too_complex",
    );

    await expectValidationError(
      validate(
        "report.docx",
        MIME.docx,
        zip([
          { name: "[Content_Types].xml", data: contentTypes("docx") },
          {
            name: "word/document.xml",
            data: "A".repeat(2_000_000),
            deflate: true,
          },
        ]),
      ),
      "archive_too_complex",
    );
  });
});

function contentFor(name: string): Uint8Array {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "png":
      return png();
    case "jpg":
    case "jpeg":
      return jpeg();
    case "webp":
      return webp();
    case "gif":
      return encoder.encode("GIF89a");
    case "svg":
      return encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    case "json":
      return encoder.encode("{}");
    case "xml":
      return encoder.encode("<root/>");
    case "pdf":
      return encoder.encode("%PDF-1.7\n");
    case "docx":
      return validDocx();
    case "xlsx":
      return validXlsx();
    default:
      return encoder.encode("safe text");
  }
}

function png(): Uint8Array {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
}

function jpeg(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
}

function webp(): Uint8Array {
  return encoder.encode("RIFF\u0004\u0000\u0000\u0000WEBP");
}

type ZipEntry = {
  name: string;
  localName?: string;
  data?: Uint8Array | string;
  deflate?: boolean;
  encrypted?: boolean;
  declaredUncompressedSize?: number;
  declaredCrc32?: number;
  dataDescriptor?: "valid" | "missing" | "invalid";
};

function validDocx(): Uint8Array {
  return zip([
    { name: "[Content_Types].xml", data: contentTypes("docx") },
    { name: "word/document.xml", data: "<document/>" },
  ]);
}

function validXlsx(): Uint8Array {
  return zip([
    { name: "[Content_Types].xml", data: contentTypes("xlsx") },
    { name: "xl/workbook.xml", data: "<workbook/>" },
  ]);
}

function contentTypes(kind: "docx" | "xlsx"): string {
  const contentType =
    kind === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  const part = kind === "docx" ? "/word/document.xml" : "/xl/workbook.xml";
  return `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="${part}" ContentType="${contentType}"/></Types>`;
}

function zip(entries: ZipEntry[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const localName = Buffer.from(entry.localName ?? entry.name, "utf8");
    const plain = Buffer.from(
      typeof entry.data === "string"
        ? encoder.encode(entry.data)
        : (entry.data ?? new Uint8Array()),
    );
    const stored = entry.deflate ? deflateRawSync(plain) : plain;
    const method = entry.deflate ? 8 : 0;
    const usesDataDescriptor = entry.dataDescriptor !== undefined;
    const flags =
      0x0800 |
      (entry.encrypted ? 0x0001 : 0) |
      (usesDataDescriptor ? 0x0008 : 0);
    const checksum = crc32(plain);
    const declaredChecksum = entry.declaredCrc32 ?? checksum;
    const declaredUncompressedSize =
      entry.declaredUncompressedSize ?? plain.byteLength;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(usesDataDescriptor ? 0 : declaredChecksum, 14);
    local.writeUInt32LE(usesDataDescriptor ? 0 : stored.byteLength, 18);
    local.writeUInt32LE(usesDataDescriptor ? 0 : declaredUncompressedSize, 22);
    local.writeUInt16LE(localName.byteLength, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(
      entry.dataDescriptor === "invalid"
        ? (checksum ^ 0xffffffff) >>> 0
        : checksum,
      4,
    );
    descriptor.writeUInt32LE(stored.byteLength, 8);
    descriptor.writeUInt32LE(declaredUncompressedSize, 12);
    const descriptorBytes =
      entry.dataDescriptor === "valid" || entry.dataDescriptor === "invalid"
        ? descriptor
        : Buffer.alloc(0);
    localParts.push(local, localName, stored, descriptorBytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(declaredChecksum, 16);
    central.writeUInt32LE(stored.byteLength, 20);
    central.writeUInt32LE(declaredUncompressedSize, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset +=
      local.byteLength +
      localName.byteLength +
      stored.byteLength +
      descriptorBytes.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
