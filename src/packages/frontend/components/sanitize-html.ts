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

// Sandbox applied to any iframe we did not vet by hostname. It deliberately
// omits allow-same-origin: the frame may still run scripts, but in an opaque
// origin, so it cannot reach the CoCalc page embedding it. This is the same
// value Jupyter output already uses for untrusted HTML
// (jupyter/output-messages/iframe.tsx).
export const UNTRUSTED_IFRAME_SANDBOX =
  "allow-forms allow-scripts allow-presentation";

// Tags that can execute script and have no sandboxing story, so they are never
// rendered, however trusted the surrounding content claims to be.
const NEVER_RENDERED_TAGS = new Set(["object", "embed", "applet"]);

// An iframe is only left alone if we vetted where it came from. Anything else
// -- srcdoc, a data: URL, or no src at all (which is about:blank, and therefore
// same-origin) -- has attacker-controllable content and must be sandboxed.
function iframeNeedsSandbox(attribs: Record<string, string>): boolean {
  if (attribs.srcdoc != null) {
    return true;
  }
  const src = attribs.src;
  if (typeof src !== "string") {
    return true;
  }
  return !isAllowedIframeSrc(src);
}

/*
The safety floor: the sanitization that applies even to content marked trusted.

`noSanitize` in the FileContext means "this content is trusted enough to keep
its classes, ids and inline styles" -- it must never mean "this content may run
scripts in our origin". Everything below is enforced on both paths.

Returns the attributes to render with, or null if the element must be dropped.
*/
export function enforceHtmlSafetyFloor(
  name: string,
  attribs: Record<string, string> | undefined,
): Record<string, string> | null {
  const tag = name.toLowerCase();
  if (NEVER_RENDERED_TAGS.has(tag)) {
    return null;
  }
  if (tag !== "iframe" || !iframeNeedsSandbox(attribs ?? {})) {
    // The overwhelmingly common case. Return the input untouched rather than
    // copying: this runs for every element of every rendered document.
    return attribs ?? {};
  }
  // sandbox is written FIRST, before src/srcdoc. React sets attributes in key
  // order, and the browser only applies sandbox flags to a load that starts
  // after the attribute is present -- if srcdoc were set first, the document
  // would begin loading unsandboxed. Any author-supplied sandbox is dropped on
  // the way, so a hand-written allow-same-origin cannot win.
  const floored: Record<string, string> = {
    sandbox: UNTRUSTED_IFRAME_SANDBOX,
  };
  for (const [attr, value] of Object.entries(attribs ?? {})) {
    if (attr.toLowerCase() !== "sandbox") {
      floored[attr] = value;
    }
  }
  return floored;
}

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
