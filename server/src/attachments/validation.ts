import { constants } from "node:fs";
import { type FileHandle, open as openFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import {
  type Entry,
  type LocalFileHeader,
  openPromise,
  validateFileName,
  type ZipFile,
} from "yauzl";
import type { AttachmentSource } from "./store";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_XML_BYTES = 5 * 1024 * 1024;
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_XML_ELEMENTS = 10_000;
const MAX_XML_DEPTH = 64;
const MAX_ATTRIBUTES_PER_ELEMENT = 128;
const MAX_TOTAL_ATTRIBUTES = 50_000;
const MAX_ATTRIBUTE_CODE_POINTS = 8_192;
const MAX_SVG_STYLE_FRAGMENTS = 10_000;
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_RATIO = 100;
const MAX_CONTENT_TYPES_BYTES = 1024 * 1024;
const MAX_OOXML_XML_PART_BYTES = 5 * 1024 * 1024;
const MAX_OOXML_XML_ELEMENTS = 250_000;
const MAX_OOXML_XML_ATTRIBUTES = 1_000_000;
const MAX_PENDING_XLSX_SHEET_REFERENCES = 1_024;
const MAX_XLSX_SHEET_NAME_CODE_POINTS = 31;
const MAX_XLSX_SHEET_NAMES = 4_096;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

const MIME_BY_EXTENSION = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
} as const;

type AllowedExtension = keyof typeof MIME_BY_EXTENSION;

export type AttachmentValidationErrorCode =
  | "invalid_name"
  | "unsupported_type"
  | "mime_mismatch"
  | "invalid_content"
  | "unsafe_content"
  | "content_too_complex"
  | "invalid_archive"
  | "unsafe_archive"
  | "archive_too_complex";

export class AttachmentValidationError extends Error {
  override readonly name = "AttachmentValidationError";

  constructor(
    readonly code: AttachmentValidationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ValidatedAttachmentMetadata = {
  name: string;
  mimeType: string;
};

export type StoredAttachmentValidationInput = {
  name: string;
  claimedMimeType: string;
  /** HTML is reserved for trusted generated artifacts and is never accepted from upload routes. */
  source?: AttachmentSource;
  /** A fresh stream over the private stored object. The validator never returns its bytes. */
  openStream?: () => Promise<ReadableStream<Uint8Array>>;
  /** Keeps the backing path inside the store's lifetime while yauzl performs random-access reads. */
  withFilePath?: <Value>(
    inspect: (internalPath: string) => Promise<Value>,
  ) => Promise<Value>;
};

type NormalizedMetadata = ValidatedAttachmentMetadata & {
  extension: AllowedExtension;
};

type OoxmlInspectionContext = {
  pendingSheetReferences: string[];
  sheetNameCount: number;
  sheetNamesByWorkbookPart: Map<string, Set<string>>;
};

/** Validate the claimed metadata and the already-stored bytes, returning metadata only. */
export async function validateStoredAttachment(
  input: StoredAttachmentValidationInput,
): Promise<ValidatedAttachmentMetadata> {
  const metadata = normalizeMetadata(
    input.name,
    input.claimedMimeType,
    input.source,
  );

  try {
    if (metadata.extension === "docx" || metadata.extension === "xlsx") {
      const archiveExtension = metadata.extension;
      if (!input.withFilePath) {
        throw validationError(
          "invalid_archive",
          "Stored OOXML attachment cannot be inspected",
        );
      }
      await input.withFilePath((internalPath) =>
        inspectOoxml(internalPath, archiveExtension),
      );
    } else {
      if (!input.openStream) {
        throw validationError(
          "invalid_content",
          "Stored attachment cannot be inspected",
        );
      }
      await inspectStream(metadata.extension, input.openStream);
    }
  } catch (error) {
    if (error instanceof AttachmentValidationError) throw error;
    throw validationError(
      metadata.extension === "docx" || metadata.extension === "xlsx"
        ? "invalid_archive"
        : "invalid_content",
      metadata.extension === "docx" || metadata.extension === "xlsx"
        ? "OOXML attachment is not a valid archive"
        : "Attachment content is invalid",
    );
  }

  return { name: metadata.name, mimeType: metadata.mimeType };
}

function normalizeMetadata(
  suppliedName: string,
  claimedMimeType: string,
  source: StoredAttachmentValidationInput["source"],
): NormalizedMetadata {
  if (typeof suppliedName !== "string") {
    throw validationError("invalid_name", "Attachment name is invalid");
  }
  const name = suppliedName.normalize("NFC").trim();
  if (
    name.length === 0 ||
    [...name].length > 255 ||
    hasFilenameControl(name) ||
    name.includes("/") ||
    name.includes("\\") ||
    name.startsWith(".") ||
    /^[a-z]:/iu.test(name)
  ) {
    throw validationError("invalid_name", "Attachment name is invalid");
  }

  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    throw validationError("unsupported_type", "Attachment type is not allowed");
  }
  const extension = name.slice(dot + 1).toLowerCase();
  if (!isAllowedExtension(extension)) {
    throw validationError("unsupported_type", "Attachment type is not allowed");
  }
  if (extension === "html" && source !== "agent_generated") {
    throw validationError("unsupported_type", "Attachment type is not allowed");
  }

  if (typeof claimedMimeType !== "string") {
    throw validationError(
      "mime_mismatch",
      "Attachment MIME type does not match its name",
    );
  }
  const normalizedMime = claimedMimeType.trim().toLowerCase();
  const mimeType = MIME_BY_EXTENSION[extension];
  if (normalizedMime !== mimeType) {
    throw validationError(
      "mime_mismatch",
      "Attachment MIME type does not match its name",
    );
  }

  return { extension, mimeType, name };
}

function isAllowedExtension(extension: string): extension is AllowedExtension {
  return Object.hasOwn(MIME_BY_EXTENSION, extension);
}

function hasFilenameControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

async function inspectStream(
  extension: Exclude<AllowedExtension, "docx" | "xlsx">,
  openStream: () => Promise<ReadableStream<Uint8Array>>,
): Promise<void> {
  switch (extension) {
    case "png":
      await requireMagic(openStream, [137, 80, 78, 71, 13, 10, 26, 10]);
      return;
    case "jpg":
    case "jpeg":
      await requireMagic(openStream, [0xff, 0xd8, 0xff]);
      return;
    case "gif": {
      const prefix = await readPrefix(openStream, 6);
      if (
        !bytesEqual(prefix, new TextEncoder().encode("GIF87a")) &&
        !bytesEqual(prefix, new TextEncoder().encode("GIF89a"))
      ) {
        throw validationError(
          "invalid_content",
          "Attachment content does not match its type",
        );
      }
      return;
    }
    case "webp": {
      const prefix = await readPrefix(openStream, 12);
      const riff = new TextEncoder().encode("RIFF");
      const webp = new TextEncoder().encode("WEBP");
      if (
        !bytesEqual(prefix.subarray(0, 4), riff) ||
        !bytesEqual(prefix.subarray(8, 12), webp)
      ) {
        throw validationError(
          "invalid_content",
          "Attachment content does not match its type",
        );
      }
      return;
    }
    case "pdf":
      await requireMagic(openStream, [...new TextEncoder().encode("%PDF-")]);
      return;
    case "txt":
    case "md":
    case "csv":
    case "html":
    case "yaml":
    case "yml":
      await readUtf8(openStream, MAX_ATTACHMENT_BYTES);
      return;
    case "json": {
      const text = await readUtf8(openStream, MAX_ATTACHMENT_BYTES);
      try {
        JSON.parse(text);
      } catch {
        throw validationError(
          "invalid_content",
          "JSON attachment is malformed",
        );
      }
      return;
    }
    case "xml": {
      const text = await readUtf8(openStream, MAX_XML_BYTES);
      parseXml(text);
      return;
    }
    case "svg": {
      const text = await readUtf8(openStream, MAX_SVG_BYTES);
      const parsed = parseXml(text, { svg: true });
      if (localName(parsed.rootName) !== "svg") {
        throw validationError(
          "unsafe_content",
          "SVG attachment has an invalid root element",
        );
      }
      return;
    }
  }
}

async function requireMagic(
  openStream: () => Promise<ReadableStream<Uint8Array>>,
  expected: number[],
): Promise<void> {
  const prefix = await readPrefix(openStream, expected.length);
  if (!bytesEqual(prefix, Uint8Array.from(expected))) {
    throw validationError(
      "invalid_content",
      "Attachment content does not match its type",
    );
  }
}

async function readPrefix(
  openStream: () => Promise<ReadableStream<Uint8Array>>,
  length: number,
): Promise<Uint8Array> {
  const stream = await openStream();
  const reader = stream.getReader();
  const prefix = new Uint8Array(length);
  let offset = 0;
  let complete = false;
  try {
    while (offset < length) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw validationError(
          "invalid_content",
          "Attachment stream is invalid",
        );
      }
      const copied = Math.min(next.value.byteLength, length - offset);
      prefix.set(next.value.subarray(0, copied), offset);
      offset += copied;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return prefix.subarray(0, offset);
}

async function readUtf8(
  openStream: () => Promise<ReadableStream<Uint8Array>>,
  maxBytes: number,
): Promise<string> {
  const stream = await openStream();
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw validationError(
          "invalid_content",
          "Attachment stream is invalid",
        );
      }
      bytes += next.value.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
        throw validationError(
          "content_too_complex",
          "Attachment content is too large to validate",
        );
      }
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    if (error instanceof AttachmentValidationError) throw error;
    throw validationError("invalid_content", "Attachment is not strict UTF-8");
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type XmlParseOptions = {
  svg?: boolean;
  onElement?: (
    name: string,
    attributes: ReadonlyMap<string, string>,
    parentName: string,
  ) => void;
  onElementEnd?: (name: string) => void;
  onText?: (parentName: string, text: string) => void;
  maxElements?: number;
  maxTotalAttributes?: number;
};

type ParsedXml = { rootName: string };

type SvgStyleText = {
  codeUnits: number;
  elementName: string;
  fragmentCount: number;
  fragments: string[];
};

function parseXml(text: string, options: XmlParseOptions = {}): ParsedXml {
  if (/<!DOCTYPE\b|<!ENTITY\b/iu.test(text)) {
    throw validationError("unsafe_content", "XML declarations are not allowed");
  }
  if (
    [...text].some(
      (character) => !isXmlCodePoint(character.codePointAt(0) ?? 0),
    )
  ) {
    throw validationError(
      "unsafe_content",
      "XML attachment contains invalid characters",
    );
  }

  const stack: string[] = [];
  let cursor = 0;
  let rootName = "";
  let rootCount = 0;
  let elements = 0;
  let totalAttributes = 0;
  let svgStyle: SvgStyleText | undefined;

  while (cursor < text.length) {
    if (text[cursor] !== "<") {
      const nextTag = text.indexOf("<", cursor);
      const end = nextTag === -1 ? text.length : nextTag;
      const rawText = text.slice(cursor, end);
      const decodedText = decodeXmlReferences(rawText);
      if (stack.length === 0 && rawText.trim().length > 0) {
        throw validationError(
          "unsafe_content",
          "XML attachment has text outside its root",
        );
      }
      if (svgStyle) appendSvgStyleFragment(svgStyle, decodedText);
      options.onText?.(stack.at(-1) ?? "", decodedText);
      cursor = end;
      continue;
    }

    if (text.startsWith("<!--", cursor)) {
      const end = text.indexOf("-->", cursor + 4);
      if (end === -1 || text.slice(cursor + 4, end).includes("--")) {
        throw validationError("unsafe_content", "XML comment is malformed");
      }
      if (svgStyle) appendSvgStyleFragment(svgStyle, "");
      cursor = end + 3;
      continue;
    }

    if (text.startsWith("<![CDATA[", cursor)) {
      const end = text.indexOf("]]>", cursor + 9);
      if (end === -1 || stack.length === 0) {
        throw validationError("unsafe_content", "XML CDATA is malformed");
      }
      const cdata = text.slice(cursor + 9, end);
      if (svgStyle) appendSvgStyleFragment(svgStyle, cdata);
      options.onText?.(stack.at(-1) ?? "", cdata);
      cursor = end + 3;
      continue;
    }

    if (text.startsWith("<?", cursor)) {
      const end = text.indexOf("?>", cursor + 2);
      if (end === -1) {
        throw validationError(
          "unsafe_content",
          "XML processing instruction is malformed",
        );
      }
      if (svgStyle) {
        throw validationError(
          "unsafe_content",
          "SVG style contains a processing instruction",
        );
      }
      const instruction = text.slice(cursor + 2, end).trim();
      if (options.svg && !/^xml(?:\s|$)/u.test(instruction)) {
        throw validationError(
          "unsafe_content",
          "SVG processing instructions are not allowed",
        );
      }
      cursor = end + 2;
      continue;
    }

    if (text.startsWith("</", cursor)) {
      const end = text.indexOf(">", cursor + 2);
      if (end === -1) {
        throw validationError("unsafe_content", "XML closing tag is malformed");
      }
      const name = text.slice(cursor + 2, end).trim();
      if (!isXmlName(name) || stack.at(-1) !== name) {
        throw validationError(
          "unsafe_content",
          "XML elements are not balanced",
        );
      }
      stack.pop();
      if (svgStyle && svgStyle.elementName === name) {
        inspectCss(svgStyle.fragments.join(""));
        svgStyle = undefined;
      }
      options.onElementEnd?.(name);
      cursor = end + 1;
      continue;
    }

    if (text.startsWith("<!", cursor)) {
      throw validationError(
        "unsafe_content",
        "XML declarations are not allowed",
      );
    }

    const end = findTagEnd(text, cursor + 1);
    if (end === -1) {
      throw validationError("unsafe_content", "XML opening tag is malformed");
    }
    const parsed = parseOpeningTag(text.slice(cursor + 1, end));
    if (svgStyle) {
      throw validationError(
        "unsafe_content",
        "SVG style contains nested markup",
      );
    }
    elements += 1;
    totalAttributes += parsed.attributes.size;
    if (
      elements > (options.maxElements ?? MAX_XML_ELEMENTS) ||
      totalAttributes > (options.maxTotalAttributes ?? MAX_TOTAL_ATTRIBUTES)
    ) {
      throw validationError(
        "content_too_complex",
        "XML attachment is too complex",
      );
    }
    if (stack.length === 0) {
      rootCount += 1;
      rootName = parsed.name;
    }
    if (rootCount > 1) {
      throw validationError(
        "unsafe_content",
        "XML attachment has multiple roots",
      );
    }
    if (options.svg) inspectSvgElement(parsed.name, parsed.attributes);
    options.onElement?.(parsed.name, parsed.attributes, stack.at(-1) ?? "");

    if (
      options.svg &&
      !parsed.selfClosing &&
      localName(parsed.name) === "style"
    ) {
      svgStyle = {
        codeUnits: 0,
        elementName: parsed.name,
        fragmentCount: 0,
        fragments: [],
      };
    }

    if (parsed.selfClosing) {
      options.onElementEnd?.(parsed.name);
    } else {
      stack.push(parsed.name);
      if (stack.length > MAX_XML_DEPTH) {
        throw validationError(
          "content_too_complex",
          "XML attachment is nested too deeply",
        );
      }
    }
    cursor = end + 1;
  }

  if (stack.length > 0 || rootCount !== 1) {
    throw validationError("unsafe_content", "XML attachment is incomplete");
  }
  return { rootName };
}

function appendSvgStyleFragment(style: SvgStyleText, fragment: string): void {
  style.fragmentCount += 1;
  style.codeUnits += fragment.length;
  if (
    style.fragmentCount > MAX_SVG_STYLE_FRAGMENTS ||
    !Number.isSafeInteger(style.codeUnits) ||
    style.codeUnits > MAX_SVG_BYTES
  ) {
    throw validationError(
      "content_too_complex",
      "SVG style content is too complex",
    );
  }
  style.fragments.push(fragment);
}

function findTagEnd(text: string, start: number): number {
  let quote = "";
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const character = text.charAt(cursor);
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return cursor;
    }
  }
  return -1;
}

function parseOpeningTag(rawTag: string): {
  name: string;
  attributes: Map<string, string>;
  selfClosing: boolean;
} {
  let body = rawTag.trim();
  const selfClosing = body.endsWith("/");
  if (selfClosing) body = body.slice(0, -1).trimEnd();

  let cursor = 0;
  while (cursor < body.length && !isXmlWhitespace(body.charAt(cursor)))
    cursor += 1;
  const name = body.slice(0, cursor);
  if (!isXmlName(name)) {
    throw validationError("unsafe_content", "XML element name is invalid");
  }

  const attributes = new Map<string, string>();
  while (cursor < body.length) {
    while (cursor < body.length && isXmlWhitespace(body.charAt(cursor)))
      cursor += 1;
    if (cursor >= body.length) break;

    const nameStart = cursor;
    while (
      cursor < body.length &&
      !isXmlWhitespace(body.charAt(cursor)) &&
      body[cursor] !== "="
    ) {
      cursor += 1;
    }
    const attributeName = body.slice(nameStart, cursor);
    if (!isXmlName(attributeName) || attributes.has(attributeName)) {
      throw validationError("unsafe_content", "XML attribute name is invalid");
    }
    while (cursor < body.length && isXmlWhitespace(body.charAt(cursor)))
      cursor += 1;
    if (body[cursor] !== "=") {
      throw validationError("unsafe_content", "XML attribute has no value");
    }
    cursor += 1;
    while (cursor < body.length && isXmlWhitespace(body.charAt(cursor)))
      cursor += 1;
    const quote = body[cursor];
    if (quote !== '"' && quote !== "'") {
      throw validationError("unsafe_content", "XML attribute must be quoted");
    }
    cursor += 1;
    const valueStart = cursor;
    const valueEnd = body.indexOf(quote, valueStart);
    if (valueEnd === -1) {
      throw validationError("unsafe_content", "XML attribute is incomplete");
    }
    const rawValue = body.slice(valueStart, valueEnd);
    if (rawValue.includes("<")) {
      throw validationError(
        "unsafe_content",
        "XML attribute contains invalid markup",
      );
    }
    const value = decodeXmlReferences(rawValue);
    if ([...value].length > MAX_ATTRIBUTE_CODE_POINTS) {
      throw validationError(
        "content_too_complex",
        "XML attribute is too large",
      );
    }
    attributes.set(attributeName, value);
    if (attributes.size > MAX_ATTRIBUTES_PER_ELEMENT) {
      throw validationError(
        "content_too_complex",
        "XML element has too many attributes",
      );
    }
    cursor = valueEnd + 1;
  }

  return { attributes, name, selfClosing };
}

function isXmlName(value: string): boolean {
  return /^[:A-Z_a-z][:A-Z_a-z0-9.-]*$/u.test(value);
}

function isXmlWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\r" || value === "\n";
}

function decodeXmlReferences(value: string): string {
  let decoded = "";
  let cursor = 0;
  while (cursor < value.length) {
    const ampersand = value.indexOf("&", cursor);
    if (ampersand === -1) return decoded + value.slice(cursor);
    decoded += value.slice(cursor, ampersand);
    const semicolon = value.indexOf(";", ampersand + 1);
    if (semicolon === -1) {
      throw validationError(
        "unsafe_content",
        "XML entity reference is malformed",
      );
    }
    const reference = value.slice(ampersand + 1, semicolon);
    const named = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' }[
      reference as "amp" | "apos" | "gt" | "lt" | "quot"
    ];
    if (named !== undefined) {
      decoded += named;
    } else {
      const match = /^#(?:(x)([0-9a-f]+)|([0-9]+))$/iu.exec(reference);
      if (!match) {
        throw validationError(
          "unsafe_content",
          "XML entity reference is not allowed",
        );
      }
      const digits = match[2] ?? match[3];
      if (!digits) {
        throw validationError(
          "unsafe_content",
          "XML character reference is invalid",
        );
      }
      const codePoint = Number.parseInt(digits, match[1] ? 16 : 10);
      if (!isXmlCodePoint(codePoint)) {
        throw validationError(
          "unsafe_content",
          "XML character reference is invalid",
        );
      }
      decoded += String.fromCodePoint(codePoint);
    }
    cursor = semicolon + 1;
  }
  return decoded;
}

function isXmlCodePoint(value: number): boolean {
  return (
    value === 0x09 ||
    value === 0x0a ||
    value === 0x0d ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff)
  );
}

function inspectSvgElement(
  name: string,
  attributes: ReadonlyMap<string, string>,
): void {
  const element = localName(name);
  if (element === "script" || element === "foreignobject") {
    throw validationError("unsafe_content", "SVG contains an unsafe element");
  }

  for (const [attributeName, value] of attributes) {
    const attribute = localName(attributeName);
    if (attribute.startsWith("on")) {
      throw validationError("unsafe_content", "SVG contains an event handler");
    }
    if (attribute === "href" || attribute === "src") {
      const reference = value.trim();
      if (reference.length > 0 && !reference.startsWith("#")) {
        throw validationError(
          "unsafe_content",
          "SVG contains an external reference",
        );
      }
    }
    if (!attributeName.toLowerCase().startsWith("xmlns")) {
      inspectReferenceValue(value);
    }
    if (attribute === "style") inspectCss(value);
  }
}

function inspectReferenceValue(value: string): void {
  const compact = value.replace(/\s+/gu, "").toLowerCase();
  if (
    compact.includes("javascript:") ||
    compact.includes("vbscript:") ||
    compact.includes("data:") ||
    compact.includes("file:") ||
    compact.includes("http:") ||
    compact.includes("https:") ||
    compact.includes("ftp:")
  ) {
    throw validationError("unsafe_content", "SVG contains an unsafe reference");
  }
  inspectCss(value);
}

function inspectCss(value: string): void {
  const canonical = canonicalCss(value);
  const compact = canonical.replace(/\s+/gu, "");
  if (
    /@import\b|(?:-webkit-)?image-set\s*\(|expression\s*\(|javascript\s*:|data\s*:/iu.test(
      canonical,
    ) ||
    /(?:https?|ftp|file|blob|wss?)\s*:/iu.test(canonical) ||
    /\/\/|\\/u.test(compact)
  ) {
    throw validationError("unsafe_content", "SVG contains unsafe CSS");
  }
  for (const match of canonical.matchAll(/url\s*\(([^)]*)\)/giu)) {
    const target = (match[1] ?? "").trim().replace(/^(['"])(.*)\1$/u, "$2");
    if (!/^#[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(target)) {
      throw validationError(
        "unsafe_content",
        "SVG contains an external CSS reference",
      );
    }
  }
}

/** Apply the CSS tokenizer's escape/comment normalization before policy matching. */
function canonicalCss(value: string): string {
  const source = stripCssComments(value);
  let decoded = "";
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source.charAt(cursor);
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    cursor += 1;
    if (cursor >= source.length) {
      throw validationError("unsafe_content", "SVG CSS escape is malformed");
    }
    const escaped = source.charAt(cursor);
    if (escaped === "\n" || escaped === "\f") continue;
    if (escaped === "\r") {
      if (source.charAt(cursor + 1) === "\n") cursor += 1;
      continue;
    }
    if (!/[0-9a-f]/iu.test(escaped)) {
      decoded += escaped;
      continue;
    }

    let digits = escaped;
    while (digits.length < 6 && /[0-9a-f]/iu.test(source.charAt(cursor + 1))) {
      cursor += 1;
      digits += source.charAt(cursor);
    }
    const codePoint = Number.parseInt(digits, 16);
    decoded +=
      codePoint === 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? "\ufffd"
        : String.fromCodePoint(codePoint);
    if (isCssWhitespace(source.charAt(cursor + 1))) {
      cursor += 1;
      if (
        source.charAt(cursor) === "\r" &&
        source.charAt(cursor + 1) === "\n"
      ) {
        cursor += 1;
      }
    }
  }

  return decoded;
}

function stripCssComments(value: string): string {
  let stripped = "";
  let quote = "";
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    const character = value.charAt(cursor);
    if (quote) {
      stripped += character;
      if (character === "\\" && cursor + 1 < value.length) {
        cursor += 1;
        stripped += value.charAt(cursor);
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      stripped += character;
      continue;
    }
    if (character === "/" && value.charAt(cursor + 1) === "*") {
      const end = value.indexOf("*/", cursor + 2);
      if (end === -1) {
        throw validationError("unsafe_content", "SVG CSS comment is malformed");
      }
      cursor = end + 1;
      continue;
    }
    stripped += character;
  }
  return stripped;
}

function isCssWhitespace(value: string): boolean {
  return (
    value === " " ||
    value === "\t" ||
    value === "\r" ||
    value === "\n" ||
    value === "\f"
  );
}

function localName(name: string): string {
  return (name.split(":").at(-1) ?? "").toLowerCase();
}

async function inspectOoxml(
  internalPath: string,
  extension: "docx" | "xlsx",
): Promise<void> {
  let archive: ZipFile | null = null;
  let archiveFile: FileHandle | null = null;
  try {
    archive = await openPromise(internalPath, {
      autoClose: false,
      // Decode names ourselves. With decodeStrings enabled yauzl rejects traversal before yielding
      // the entry, which would collapse a known unsafe path into an untyped parser failure.
      decodeStrings: false,
      lazyEntries: true,
      strictFileNames: false,
      validateEntrySizes: false,
    });
    archiveFile = await openFile(
      internalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    if (archive.entryCount < 1) {
      throw validationError("invalid_archive", "OOXML archive is empty");
    }
    if (archive.entryCount > MAX_ARCHIVE_ENTRIES) {
      throw validationError(
        "archive_too_complex",
        "OOXML archive has too many entries",
      );
    }

    const seen = new Set<string>();
    let totalCompressed = 0;
    let totalUncompressed = 0;
    let contentTypes: string | null = null;
    const inspectionContext: OoxmlInspectionContext = {
      pendingSheetReferences: [],
      sheetNameCount: 0,
      sheetNamesByWorkbookPart: new Map(),
    };

    for await (const entry of archive.eachEntry()) {
      entry.fileName = decodeArchiveEntryName(entry.fileNameRaw);
      assertSafeArchiveEntry(entry, seen);
      const localHeader = await assertMatchingLocalHeader(archive, entry);
      const isDirectory = entry.fileName.endsWith("/");
      if (!isDirectory) {
        totalCompressed = safeArchiveSum(totalCompressed, entry.compressedSize);
        if (
          entry.uncompressedSize > MAX_ARCHIVE_UNCOMPRESSED_BYTES ||
          (entry.uncompressedSize > 0 &&
            entry.uncompressedSize / Math.max(1, entry.compressedSize) >
              MAX_ARCHIVE_RATIO)
        ) {
          throw validationError(
            "archive_too_complex",
            "OOXML archive compression ratio is unsafe",
          );
        }
      }

      const lowerName = entry.fileName.toLowerCase();
      if (isActiveOoxmlEntry(lowerName)) {
        throw validationError(
          "unsafe_archive",
          "OOXML active content is not allowed",
        );
      }
      if (!isDirectory) {
        const captureLimit = ooxmlCaptureLimit(entry.fileName, lowerName);
        const measured = await measureZipEntry(
          archive,
          entry,
          totalUncompressed,
          totalCompressed,
          captureLimit,
        );
        totalUncompressed = measured.totalUncompressed;
        if (measured.bytes) {
          const text = decodeUtf8(measured.bytes);
          if (entry.fileName === "[Content_Types].xml") {
            contentTypes = text;
          } else if (lowerName.endsWith(".rels")) {
            inspectOoxmlRelationships(text);
          } else {
            inspectOoxmlXmlPart(
              text,
              entry.fileName,
              lowerName,
              inspectionContext,
            );
          }
        }
        if ((entry.generalPurposeBitFlag & 0x0008) !== 0) {
          await assertDataDescriptor(
            archiveFile,
            archive.fileSize,
            entry,
            localHeader,
          );
        }
      }
    }

    if (
      totalUncompressed > 0 &&
      totalUncompressed / Math.max(1, totalCompressed) > MAX_ARCHIVE_RATIO
    ) {
      throw validationError(
        "archive_too_complex",
        "OOXML archive compression ratio is unsafe",
      );
    }
    if (!contentTypes) {
      throw validationError(
        "invalid_archive",
        "OOXML package structure is incomplete",
      );
    }
    const mainPart = inspectContentTypes(contentTypes, extension);
    if (!seen.has(mainPart)) {
      throw validationError(
        "invalid_archive",
        "OOXML package does not contain its declared main part",
      );
    }
    if (extension === "xlsx") {
      assertPendingXlsxSheetReferences(inspectionContext, mainPart);
    }
  } catch (error) {
    if (error instanceof AttachmentValidationError) throw error;
    throw validationError(
      "invalid_archive",
      "OOXML attachment is not a valid archive",
    );
  } finally {
    archive?.close();
    await archiveFile?.close().catch(() => {});
  }
}

async function assertMatchingLocalHeader(
  archive: ZipFile,
  entry: Entry,
): Promise<LocalFileHeader> {
  const local = await archive.readLocalFileHeaderPromise(entry);
  if (
    !bytesEqual(local.fileName, entry.fileNameRaw) ||
    local.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
    local.compressionMethod !== entry.compressionMethod
  ) {
    throw validationError(
      "unsafe_archive",
      "OOXML local and central entry metadata do not match",
    );
  }
  const usesDataDescriptor = (entry.generalPurposeBitFlag & 0x0008) !== 0;
  if (
    (!usesDataDescriptor &&
      (local.crc32 !== entry.crc32 ||
        local.compressedSize !== entry.compressedSize ||
        local.uncompressedSize !== entry.uncompressedSize)) ||
    (usesDataDescriptor &&
      (local.crc32 !== 0 ||
        local.compressedSize !== 0 ||
        local.uncompressedSize !== 0))
  ) {
    throw validationError(
      "unsafe_archive",
      "OOXML local and central entry integrity metadata do not match",
    );
  }
  return local;
}

async function assertDataDescriptor(
  archiveFile: FileHandle,
  archiveSize: number,
  entry: Entry,
  local: LocalFileHeader,
): Promise<void> {
  const descriptorOffset = safeArchiveSum(
    local.fileDataStart,
    entry.compressedSize,
  );
  if (descriptorOffset > archiveSize - 12) {
    throw validationError("unsafe_archive", "OOXML data descriptor is missing");
  }

  const descriptor = Buffer.alloc(16);
  const { bytesRead } = await archiveFile.read(
    descriptor,
    0,
    descriptor.byteLength,
    descriptorOffset,
  );
  let cursor = 0;
  if (descriptor.readUInt32LE(0) === ZIP_DATA_DESCRIPTOR_SIGNATURE) {
    if (bytesRead < 16) {
      throw validationError(
        "unsafe_archive",
        "OOXML data descriptor is incomplete",
      );
    }
    cursor = 4;
  } else if (bytesRead < 12) {
    throw validationError(
      "unsafe_archive",
      "OOXML data descriptor is incomplete",
    );
  }

  if (
    descriptor.readUInt32LE(cursor) !== entry.crc32 ||
    descriptor.readUInt32LE(cursor + 4) !== entry.compressedSize ||
    descriptor.readUInt32LE(cursor + 8) !== entry.uncompressedSize
  ) {
    throw validationError(
      "unsafe_archive",
      "OOXML data descriptor does not match its central entry",
    );
  }
}

function decodeArchiveEntryName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw validationError(
      "unsafe_archive",
      "OOXML entry name is not strict UTF-8",
    );
  }
}

function assertSafeArchiveEntry(entry: Entry, seen: Set<string>): void {
  const fileNameError = validateFileName(entry.fileName);
  if (
    fileNameError !== null ||
    entry.fileName.includes("\\") ||
    entry.fileName.startsWith("/") ||
    /^[a-z]:/iu.test(entry.fileName) ||
    seen.has(entry.fileName)
  ) {
    throw validationError(
      "unsafe_archive",
      "OOXML archive contains an unsafe path",
    );
  }
  seen.add(entry.fileName);
  if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x0001) !== 0) {
    throw validationError(
      "unsafe_archive",
      "Encrypted OOXML entries are not allowed",
    );
  }
  if (!entry.canDecodeFileData()) {
    throw validationError(
      "unsafe_archive",
      "OOXML archive uses an unsupported encoding",
    );
  }
  if (
    !Number.isSafeInteger(entry.compressedSize) ||
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.compressedSize < 0 ||
    entry.uncompressedSize < 0
  ) {
    throw validationError("archive_too_complex", "OOXML entry size is invalid");
  }
}

function safeArchiveSum(total: number, value: number): number {
  const next = total + value;
  if (!Number.isSafeInteger(next)) {
    throw validationError(
      "archive_too_complex",
      "OOXML archive size is invalid",
    );
  }
  return next;
}

function isActiveOoxmlEntry(lowerName: string): boolean {
  return (
    lowerName.endsWith("/vbaproject.bin") ||
    lowerName.endsWith("/vbadata.xml") ||
    lowerName.includes("/macrosheets/") ||
    lowerName.includes("/xl4macros/") ||
    lowerName.includes("/macros/") ||
    lowerName.startsWith("word/embeddings/") ||
    lowerName.startsWith("xl/embeddings/") ||
    lowerName.startsWith("word/activex/") ||
    lowerName.startsWith("xl/activex/") ||
    lowerName.startsWith("xl/externallinks/") ||
    lowerName === "xl/connections.xml"
  );
}

function ooxmlCaptureLimit(
  fileName: string,
  lowerName: string,
): number | undefined {
  if (fileName === "[Content_Types].xml") return MAX_CONTENT_TYPES_BYTES;
  if (
    lowerName.endsWith(".rels") ||
    ((lowerName.startsWith("word/") || lowerName.startsWith("xl/")) &&
      lowerName.endsWith(".xml"))
  ) {
    return MAX_OOXML_XML_PART_BYTES;
  }
  return undefined;
}

async function measureZipEntry(
  archive: ZipFile,
  entry: Entry,
  totalUncompressed: number,
  totalCompressed: number,
  captureLimit?: number,
): Promise<{ bytes: Uint8Array | null; totalUncompressed: number }> {
  if (captureLimit !== undefined && entry.uncompressedSize > captureLimit) {
    throw validationError(
      "archive_too_complex",
      "OOXML metadata entry is too large",
    );
  }
  const stream = await archive.openReadStreamPromise(entry);
  const chunks: Uint8Array[] | null = captureLimit === undefined ? null : [];
  let entryUncompressed = 0;
  let entryCrc32 = 0;
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) {
        throw validationError(
          "invalid_archive",
          "OOXML entry stream is invalid",
        );
      }
      entryUncompressed = safeArchiveSum(entryUncompressed, chunk.byteLength);
      totalUncompressed = safeArchiveSum(totalUncompressed, chunk.byteLength);
      entryCrc32 = crc32(chunk, entryCrc32);
      if (
        totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES ||
        entryUncompressed >
          Math.max(1, entry.compressedSize) * MAX_ARCHIVE_RATIO ||
        totalUncompressed > Math.max(1, totalCompressed) * MAX_ARCHIVE_RATIO
      ) {
        throw validationError(
          "archive_too_complex",
          "OOXML archive expands beyond its limit",
        );
      }
      if (captureLimit !== undefined && entryUncompressed > captureLimit) {
        throw validationError(
          "archive_too_complex",
          "OOXML metadata entry is too large",
        );
      }
      chunks?.push(chunk);
    }
  } catch (error) {
    stream.destroy();
    throw error;
  }
  if (entryUncompressed !== entry.uncompressedSize) {
    if (entryUncompressed > entry.uncompressedSize) {
      throw validationError(
        "archive_too_complex",
        "OOXML entry expands beyond its declared size",
      );
    }
    throw validationError(
      "invalid_archive",
      "OOXML entry size does not match its declaration",
    );
  }
  if (entryCrc32 !== entry.crc32) {
    throw validationError(
      "invalid_archive",
      "OOXML entry checksum does not match its declaration",
    );
  }
  if (!chunks) return { bytes: null, totalUncompressed };
  const joined = new Uint8Array(entryUncompressed);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: joined, totalUncompressed };
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw validationError(
      "unsafe_archive",
      "OOXML metadata is not strict UTF-8",
    );
  }
}

function inspectOoxmlRelationships(text: string): void {
  let rootName = "";
  try {
    const parsed = parseXml(text, {
      onElement(name, attributes) {
        if (localName(name) !== "relationship") return;
        const targetMode = attributes.get("TargetMode")?.trim().toLowerCase();
        const target = attributes.get("Target")?.trim() ?? "";
        const type = attributes.get("Type")?.trim().toLowerCase() ?? "";
        if (
          targetMode === "external" ||
          isExternalRelationshipTarget(target) ||
          isActiveRelationshipType(type)
        ) {
          throw validationError(
            "unsafe_archive",
            "OOXML external or active relationships are not allowed",
          );
        }
        if (targetMode !== undefined && targetMode !== "internal") {
          throw validationError(
            "unsafe_archive",
            "OOXML relationship target mode is invalid",
          );
        }
      },
    });
    rootName = parsed.rootName;
  } catch (error) {
    if (error instanceof AttachmentValidationError) throw error;
    throw validationError("unsafe_archive", "OOXML relationships are unsafe");
  }
  if (localName(rootName) !== "relationships") {
    throw validationError(
      "unsafe_archive",
      "OOXML relationships have an invalid root",
    );
  }
}

function isExternalRelationshipTarget(target: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/iu.test(target) ||
    target.startsWith("//") ||
    target.startsWith("\\\\")
  );
}

function isActiveRelationshipType(type: string): boolean {
  return (
    type.endsWith("/oleobject") ||
    type.endsWith("/package") ||
    type.endsWith("/activex") ||
    type.endsWith("/externallink") ||
    type.endsWith("/connection")
  );
}

function inspectOoxmlXmlPart(
  text: string,
  entryName: string,
  lowerName: string,
  context: OoxmlInspectionContext,
): void {
  const wordInstructionFragments: string[] = [];
  let formulaFragments: string[] | null = null;
  let insideInstructionText = false;
  const isSpreadsheetPart = lowerName.startsWith("xl/");
  let isWorkbookDocument = false;
  let firstElement = true;
  let insideWorkbookSheets = false;
  const declaredSheetNames = new Set<string>();
  try {
    parseXml(text, {
      maxElements: MAX_OOXML_XML_ELEMENTS,
      maxTotalAttributes: MAX_OOXML_XML_ATTRIBUTES,
      onElement(name, attributes, parentName) {
        const element = localName(name);
        if (firstElement) {
          isWorkbookDocument = isSpreadsheetPart && element === "workbook";
          firstElement = false;
        }
        if (formulaFragments && element !== "f") {
          throw validationError(
            "unsafe_archive",
            "OOXML formula contains nested markup",
          );
        }
        if (insideInstructionText && element !== "instrtext") {
          throw validationError(
            "unsafe_archive",
            "OOXML field instruction contains nested markup",
          );
        }
        if (isSpreadsheetPart && element === "f") {
          if (formulaFragments) {
            throw validationError(
              "unsafe_archive",
              "OOXML formula contains nested markup",
            );
          }
          formulaFragments = [];
        }
        if (element === "instrtext") {
          if (insideInstructionText) {
            throw validationError(
              "unsafe_archive",
              "OOXML field instruction contains nested markup",
            );
          }
          insideInstructionText = true;
        }
        if (
          isWorkbookDocument &&
          element === "sheets" &&
          localName(parentName) === "workbook"
        ) {
          insideWorkbookSheets = true;
        }
        if (
          insideWorkbookSheets &&
          element === "sheet" &&
          localName(parentName) === "sheets"
        ) {
          const sheetName = attributes.get("name");
          if (!sheetName || !isValidXlsxSheetName(sheetName)) {
            throw validationError(
              "unsafe_archive",
              "OOXML workbook contains an invalid sheet name",
            );
          }
          if (!declaredSheetNames.has(sheetName)) {
            declaredSheetNames.add(sheetName);
            context.sheetNameCount += 1;
            if (context.sheetNameCount > MAX_XLSX_SHEET_NAMES) {
              throw validationError(
                "archive_too_complex",
                "OOXML workbook declares too many sheet names",
              );
            }
          }
        }
        for (const [attributeName, value] of attributes) {
          if (localName(attributeName) === "instr") {
            assertNoOoxmlDde(value);
          }
        }
      },
      onElementEnd(name) {
        const element = localName(name);
        if (isSpreadsheetPart && element === "f" && formulaFragments) {
          assertNoOoxmlDde(formulaFragments.join(""), true, context);
          formulaFragments = null;
        }
        if (element === "instrtext") insideInstructionText = false;
        if (element === "sheets") insideWorkbookSheets = false;
      },
      onText(parentName, value) {
        const parent = localName(parentName);
        if (parent === "instrtext") wordInstructionFragments.push(value);
        if (isSpreadsheetPart && parent === "f" && formulaFragments) {
          formulaFragments.push(value);
        }
      },
    });
  } catch (error) {
    if (error instanceof AttachmentValidationError) throw error;
    throw validationError("unsafe_archive", "OOXML XML content is unsafe");
  }
  assertNoOoxmlDde(wordInstructionFragments.join(""));
  if (isWorkbookDocument) {
    context.sheetNamesByWorkbookPart.set(entryName, declaredSheetNames);
  }
}

function assertNoOoxmlDde(
  value: string,
  formula = false,
  context?: OoxmlInspectionContext,
): void {
  const inspectedValue = formula
    ? maskAmbiguousXlsxSheetReferences(value, (sheetReference) => {
        if (!context || !isValidXlsxSheetName(sheetReference)) {
          throw validationError(
            "unsafe_archive",
            "OOXML ambiguous sheet reference is unsafe",
          );
        }
        if (
          context.pendingSheetReferences.length >=
          MAX_PENDING_XLSX_SHEET_REFERENCES
        ) {
          throw validationError(
            "archive_too_complex",
            "OOXML contains too many ambiguous sheet references",
          );
        }
        context.pendingSheetReferences.push(sheetReference);
      })
    : value;
  if (
    /(?:^|[^a-z0-9_])dde(?:auto)?(?:$|[^a-z0-9_])/iu.test(inspectedValue) ||
    (formula && isDdeFormula(inspectedValue))
  ) {
    throw validationError(
      "unsafe_archive",
      "OOXML DDE field instructions are not allowed",
    );
  }
}

function maskAmbiguousXlsxSheetReferences(
  value: string,
  onSheetReference: (sheetReference: string) => void,
): string {
  let masked = "";
  let cursor = 0;
  while (cursor < value.length) {
    const character = value.charAt(cursor);
    if (character === '"') {
      cursor += 1;
      let closed = false;
      while (cursor < value.length) {
        if (value.charAt(cursor) !== '"') {
          cursor += 1;
          continue;
        }
        if (value.charAt(cursor + 1) === '"') {
          cursor += 2;
          continue;
        }
        cursor += 1;
        closed = true;
        break;
      }
      if (!closed) {
        throw validationError(
          "unsafe_archive",
          "OOXML formula contains an unterminated string literal",
        );
      }
      masked += "__string__";
      continue;
    }
    if (character !== "'") {
      masked += character;
      cursor += 1;
      continue;
    }

    const start = cursor;
    cursor += 1;
    let decodedHead = "";
    let closed = false;
    while (cursor < value.length) {
      const headCharacter = value.charAt(cursor);
      if (headCharacter !== "'") {
        decodedHead += headCharacter;
        cursor += 1;
        continue;
      }
      if (value.charAt(cursor + 1) === "'") {
        decodedHead += "'";
        cursor += 2;
        continue;
      }
      closed = true;
      cursor += 1;
      break;
    }

    const pipeBearing = decodedHead.includes("|");
    if (!closed) {
      if (pipeBearing) {
        throw validationError(
          "unsafe_archive",
          "OOXML quoted sheet reference is malformed",
        );
      }
      masked += value.slice(start);
      break;
    }

    let bang = cursor;
    while (isXmlWhitespace(value.charAt(bang))) bang += 1;
    if (value.charAt(bang) !== "!") {
      if (pipeBearing) {
        throw validationError(
          "unsafe_archive",
          "OOXML quoted sheet reference is malformed",
        );
      }
      masked += value.slice(start, cursor);
      continue;
    }
    const afterBang = bang + 1;
    if (value.slice(afterBang).trim().length === 0) {
      if (pipeBearing) {
        throw validationError(
          "unsafe_archive",
          "OOXML quoted sheet reference has no item",
        );
      }
      masked += value.slice(start, afterBang);
      cursor = afterBang;
      continue;
    }

    if (pipeBearing) {
      onSheetReference(decodedHead);
      masked += "__sheet__!";
    } else {
      masked += value.slice(start, afterBang);
    }
    cursor = afterBang;
  }
  return masked;
}

function isValidXlsxSheetName(value: string): boolean {
  const codePoints = [...value];
  const hasInvalidCharacter = codePoints.some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || "\\/:?*[]".includes(character);
  });
  return (
    codePoints.length > 0 &&
    codePoints.length <= MAX_XLSX_SHEET_NAME_CODE_POINTS &&
    !hasInvalidCharacter &&
    !value.startsWith("'") &&
    !value.endsWith("'")
  );
}

function assertPendingXlsxSheetReferences(
  context: OoxmlInspectionContext,
  workbookPart: string,
): void {
  const sheetNames = context.sheetNamesByWorkbookPart.get(workbookPart);
  if (
    context.pendingSheetReferences.some(
      (sheetReference) => !sheetNames?.has(sheetReference),
    )
  ) {
    throw validationError(
      "unsafe_archive",
      "OOXML contains a DDE or unknown sheet reference",
    );
  }
}

function isDdeFormula(value: string): boolean {
  const candidate = value.trim();
  const expression = candidate.startsWith("=")
    ? candidate.slice(1).trim()
    : candidate;
  const pipe = findFormulaDelimiter(expression, "|");
  if (pipe <= 0) return false;
  const bang = findFormulaDelimiter(expression, "!", pipe + 1);
  if (bang <= pipe + 1) return false;
  return (
    unquoteFormulaPart(expression.slice(0, pipe)).length > 0 &&
    unquoteFormulaPart(expression.slice(pipe + 1, bang)).length > 0 &&
    unquoteFormulaPart(expression.slice(bang + 1)).length > 0
  );
}

function findFormulaDelimiter(
  value: string,
  delimiter: "!" | "|",
  start = 0,
): number {
  let insideString = false;
  for (let cursor = start; cursor < value.length; cursor += 1) {
    const character = value.charAt(cursor);
    if (insideString) {
      if (character === '"') {
        if (value.charAt(cursor + 1) === '"') cursor += 1;
        else insideString = false;
      }
    } else if (character === '"') {
      insideString = true;
    } else if (character === delimiter) {
      return cursor;
    }
  }
  return -1;
}

function unquoteFormulaPart(value: string): string {
  const part = value.trim();
  const quote = part.charAt(0);
  return part.length >= 2 &&
    (quote === '"' || quote === "'") &&
    part.charAt(part.length - 1) === quote
    ? part.slice(1, -1).trim()
    : part;
}

function inspectContentTypes(text: string, extension: "docx" | "xlsx"): string {
  const mainParts = new Set<string>();
  let hasActiveContentType = false;
  let parsed: ParsedXml;
  try {
    parsed = parseXml(text, {
      onElement(name, attributes) {
        for (const value of attributes.values()) {
          const normalized = value.toLowerCase();
          if (
            normalized.includes("macroenabled") ||
            normalized.includes("vbaproject") ||
            normalized.includes("oleobject") ||
            normalized.includes("activex") ||
            normalized.includes("externallink")
          ) {
            hasActiveContentType = true;
          }
        }
        if (localName(name) !== "override") return;
        const partName = attributes.get("PartName");
        const contentType = attributes.get("ContentType");
        const expectedPrefix = extension === "docx" ? "/word/" : "/xl/";
        const expectedContentType =
          extension === "docx"
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
        if (
          partName?.startsWith(expectedPrefix) &&
          contentType === expectedContentType
        ) {
          const archiveName = partName.slice(1);
          if (
            validateFileName(archiveName) === null &&
            !archiveName.endsWith("/")
          ) {
            mainParts.add(archiveName);
          }
        }
      },
    });
  } catch {
    throw validationError("unsafe_archive", "OOXML content types are unsafe");
  }
  if (localName(parsed.rootName) !== "types" || mainParts.size !== 1) {
    throw validationError(
      "invalid_archive",
      "OOXML content types do not match its extension",
    );
  }
  if (hasActiveContentType) {
    throw validationError(
      "unsafe_archive",
      "OOXML active content types are not allowed",
    );
  }
  return [...mainParts][0] ?? "";
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function validationError(
  code: AttachmentValidationErrorCode,
  message: string,
): AttachmentValidationError {
  return new AttachmentValidationError(code, message);
}
