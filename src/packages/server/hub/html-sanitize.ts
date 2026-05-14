/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Parser } from "htmlparser2";

const DROP_CONTENT_TAGS = new Set([
  "script",
  "style",
  "textarea",
  "option",
  "xmp",
]);

const VOID_TAGS = new Set(["br", "hr"]);
const SAFE_URL_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

function encodeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function isSafeEmailUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
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

function renderAttributes(
  tag: string,
  attribs: Record<string, string>,
  allowUrls: boolean,
): string {
  if (tag !== "a" || !allowUrls) {
    return "";
  }
  const rendered: string[] = [];
  const href = attribs.href;
  if (href != null && isSafeEmailUrl(href)) {
    rendered.push(`href="${encodeHTML(href)}"`);
  }
  const name = attribs.name;
  if (name != null) {
    rendered.push(`name="${encodeHTML(name)}"`);
  }
  const target = attribs.target;
  if (target === "_blank") {
    rendered.push('target="_blank"', 'rel="noopener noreferrer"');
  }
  return rendered.length === 0 ? "" : ` ${rendered.join(" ")}`;
}

export function sanitizeEmailHtml(
  html: string,
  {
    allowedTags,
    allowUrls,
  }: {
    allowedTags: string[];
    allowUrls: boolean;
  },
): string {
  const allowed = new Set(allowedTags.map((tag) => tag.toLowerCase()));
  let output = "";
  let dropDepth = 0;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        if (dropDepth > 0) {
          if (DROP_CONTENT_TAGS.has(tag)) {
            dropDepth += 1;
          }
          return;
        }
        if (!allowed.has(tag)) {
          if (DROP_CONTENT_TAGS.has(tag)) {
            dropDepth = 1;
          }
          return;
        }
        output += `<${tag}${renderAttributes(tag, attribs, allowUrls)}>`;
      },
      ontext(text) {
        if (dropDepth === 0) {
          output += encodeHTML(text);
        }
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (dropDepth > 0) {
          if (DROP_CONTENT_TAGS.has(tag)) {
            dropDepth -= 1;
          }
          return;
        }
        if (allowed.has(tag) && !VOID_TAGS.has(tag)) {
          output += `</${tag}>`;
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return output;
}
