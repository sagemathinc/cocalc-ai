/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const ALLOWED_TAGS = new Set([
  "address",
  "article",
  "aside",
  "footer",
  "header",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hgroup",
  "main",
  "nav",
  "section",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "hr",
  "li",
  "menu",
  "ol",
  "p",
  "pre",
  "ul",
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "br",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "i",
  "kbd",
  "mark",
  "q",
  "rb",
  "rp",
  "rt",
  "rtc",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
  "wbr",
  "caption",
  "col",
  "colgroup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "img",
  "iframe",
]);

const DROP_CONTENT_TAGS = new Set([
  "script",
  "style",
  "textarea",
  "option",
  "xmp",
]);

const IFRAME_HOSTNAMES = new Set([
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
  "player.vimeo.com",
]);

const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href", "name", "target"]),
  img: new Set(["src", "srcset", "alt", "title", "width", "height", "loading"]),
  iframe: new Set([
    "src",
    "width",
    "height",
    "title",
    "allow",
    "allowfullscreen",
    "referrerpolicy",
    "loading",
    "frameborder",
  ]),
};

const URL_ATTRIBUTES = new Set(["href", "src", "data"]);
const SAFE_URL_SCHEMES = new Set([
  "http:",
  "https:",
  "ftp:",
  "mailto:",
  "tel:",
]);

export function isAllowedHtmlTag(name: string): boolean {
  return ALLOWED_TAGS.has(name.toLowerCase());
}

export function shouldDropHtmlTagContents(name: string): boolean {
  return DROP_CONTENT_TAGS.has(name.toLowerCase());
}

function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return true;
  }
  if (trimmed.startsWith("//")) {
    return true;
  }
  try {
    const url = new URL(trimmed, "https://cocalc.invalid/");
    if (
      url.origin === "https://cocalc.invalid" &&
      !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ) {
      return true;
    }
    return SAFE_URL_SCHEMES.has(url.protocol);
  } catch {
    return false;
  }
}

function sanitizeSrcset(value: string): string | undefined {
  const candidates = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => isSafeUrl(part.split(/\s+/)[0] ?? ""));
  return candidates.length > 0 ? candidates.join(", ") : undefined;
}

function isAllowedIframeSrc(value: string): boolean {
  try {
    const url = new URL(value, "https://cocalc.invalid/");
    return IFRAME_HOSTNAMES.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function sanitizeHtmlAttributes(
  name: string,
  attribs: Record<string, string> | undefined,
  urlTransform?: (url: string, tag?: string) => string | undefined,
): Record<string, string> {
  const tag = name.toLowerCase();
  const allowed = ALLOWED_ATTRIBUTES[tag];
  if (allowed == null || attribs == null) {
    return {};
  }
  const sanitized: Record<string, string> = {};
  for (const [rawAttr, rawValue] of Object.entries(attribs)) {
    const attr = rawAttr.toLowerCase();
    if (!allowed.has(attr) || attr.startsWith("on")) {
      continue;
    }
    if (rawValue == null) {
      continue;
    }
    const transformed =
      URL_ATTRIBUTES.has(attr) && urlTransform != null
        ? (urlTransform(rawValue, tag) ?? rawValue)
        : rawValue;
    if (attr === "srcset") {
      const clean = sanitizeSrcset(transformed);
      if (clean != null) {
        sanitized[attr] = clean;
      }
      continue;
    }
    if (URL_ATTRIBUTES.has(attr) && !isSafeUrl(transformed)) {
      continue;
    }
    if (
      tag === "iframe" &&
      attr === "src" &&
      !isAllowedIframeSrc(transformed)
    ) {
      continue;
    }
    sanitized[attr] = attr === "allowfullscreen" ? "" : transformed;
  }
  if (tag === "a" && sanitized.target === "_blank") {
    sanitized.rel = "noopener noreferrer";
  }
  return sanitized;
}
