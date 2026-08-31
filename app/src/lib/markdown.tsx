import {
  IconFile,
  IconFileText,
  IconPresentation,
  IconTable,
} from "@tabler/icons-react";
import type { ComponentProps } from "react";
import type { UrlTransform } from "streamdown";

/**
 * Shared markdown rendering for Bot prose and tool results.
 *
 * Links open in a new tab with `noreferrer` because content can come from a model or remote MCP
 * server.
 */

/**
 * A document this deployment can recognise, drawn as a chip rather than as underlined text.
 *
 * WHY A CHIP. A knowledge answer is mostly a claim plus the thing it came from, and those two want
 * to look different. Underlined blue text in the middle of a sentence reads as "more about this";
 * a chip with the file's own type on it reads as "this is the document", which is the whole point of
 * a connector that answers from a live system. It also survives the model's phrasing: whether it
 * writes "I found it in X" or lists three files, each one is drawn the same way.
 *
 * Recognition is by URL, and only document hosts this deployment knows about. Anything else is an
 * ordinary link, because a chip asserts "this is a file in a system you have connected" and that
 * is not something to claim about a URL a model wrote.
 */
const DRIVE_KINDS = [
  { match: "/document/", icon: IconFileText, label: "Doc" },
  { match: "/spreadsheets/", icon: IconTable, label: "Sheet" },
  { match: "/presentation/", icon: IconPresentation, label: "Slides" },
] as const;

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const MEDIA_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Keep ordinary relative and web links while refusing active/local schemes from model content.
 *
 * Streamdown's default hardener intentionally permits every protocol. This transform is therefore
 * supplied at each transcript renderer, and the anchor component repeats the href check so a future
 * caller that only reuses the components does not accidentally restore javascript/data/file links.
 */
export function safeMarkdownUrl(
  value: string | undefined,
  key: string = "href",
): string | null {
  if (value === undefined) return null;
  const url = value.trim();
  if (url.length === 0 || hasUrlControl(url)) return null;

  const scheme = /^([a-z][a-z\d+.-]*):/iu.exec(url)?.[1]?.toLowerCase();
  if (scheme === undefined) return url;
  const protocol = `${scheme}:`;
  const allowed = key === "src" ? MEDIA_PROTOCOLS : LINK_PROTOCOLS;
  return allowed.has(protocol) ? url : null;
}

export const markdownUrlTransform: UrlTransform = (url, key) =>
  safeMarkdownUrl(url, key);

/** Artifact previews never load model-authored media from the viewer's browser or local network. */
export const artifactMarkdownUrlTransform: UrlTransform = (url, key) =>
  key === "src" ? null : safeMarkdownUrl(url, key);

function hasUrlControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

export function documentChipKind(href: string | undefined) {
  if (!href) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    // A relative or malformed href is not a recognised document, and is not worth throwing over.
    return null;
  }

  /*
   * Exact hosts, never a suffix test. `docs.google.com.evil.test` ends with the string and is
   * somebody else's domain, and a chip is a statement that this is a real file in a real connected
   * system — the one kind of link where dressing up an impostor does actual harm.
   */
  if (url.protocol !== "https:") return null;
  if (url.hostname === "docs.google.com") {
    const kind = DRIVE_KINDS.find((entry) =>
      url.pathname.includes(entry.match),
    );
    // A docs.google.com URL of some other shape is still a Drive document, just not one of the three.
    return kind ?? { match: "", icon: IconFile, label: "Drive" };
  }
  if (url.hostname === "drive.google.com") {
    return { match: "", icon: IconFile, label: "Drive" };
  }
  /*
   * Same exact-host rule as Drive: a chip asserts "this is a document in a system you have
   * connected", and notion.so.evil.test is somebody else's domain wearing the name.
   */
  if (url.hostname === "notion.so" || url.hostname === "www.notion.so") {
    return { match: "", icon: IconFileText, label: "Notion" };
  }
  return null;
}

export const markdownComponents = {
  a: ({ href, children, ...rest }: ComponentProps<"a">) => {
    const safeHref = safeMarkdownUrl(href);
    const kind = documentChipKind(safeHref ?? undefined);

    if (!safeHref) {
      return <span className="text-muted-foreground">{children}</span>;
    }

    if (kind) {
      const Icon = kind.icon;
      return (
        <a
          {...rest}
          /*
           * `align-middle` and the tighter line height keep a chip from pushing the line it sits in
           * taller than its neighbours, which is what turns a paragraph with three citations in it
           * into a ragged block.
           */
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-1.5 py-0.5 align-middle text-xs leading-tight no-underline transition-colors hover:bg-muted"
          href={safeHref}
          rel="noreferrer noopener"
          target="_blank"
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          {/* Truncated rather than wrapped: a long file name should not reflow the sentence around it. */}
          <span className="truncate">{children}</span>
          {/*
           * The type, after the name. It answers "can I open this, and with what" without the reader
           * hovering to read a URL, and it is the part a file name often leaves out.
           */}
          <span className="shrink-0 text-muted-foreground">{kind.label}</span>
        </a>
      );
    }

    return (
      <a
        {...rest}
        className="underline underline-offset-2 hover:no-underline"
        href={safeHref}
        rel="noreferrer noopener"
        target="_blank"
      >
        {children}
      </a>
    );
  },
};

export const artifactMarkdownComponents = {
  ...markdownComponents,
  img: ({ alt }: ComponentProps<"img">) => (
    <span className="text-muted-foreground">
      {alt ? `[Изображение: ${alt}]` : "[Изображение недоступно]"}
    </span>
  ),
};
