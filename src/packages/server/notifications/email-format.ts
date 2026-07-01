/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Parser } from "htmlparser2";
import MarkdownIt from "markdown-it";

const USER_MENTION_SPAN =
  /<span\b(?=[^>]*\bclass\s*=\s*(?:"[^"]*\buser-mention\b[^"]*"|'[^']*\buser-mention\b[^']*'|[^\s>]*\buser-mention\b[^\s>]*))(?=[^>]*\baccount-id\b)[^>]*>([\s\S]*?)<\/span>/gi;
const BR_TAG = /<br\s*\/?>/gi;
const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
});

export function escapeNotificationEmailHtml(value: unknown): string {
  return `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlFragmentToText(html: string): string {
  let text = "";
  const parser = new Parser(
    {
      ontext(value) {
        text += value;
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return text;
}

function formatMentionText(html: string): string {
  const text = htmlFragmentToText(html).replace(/\s+/g, " ").trim();
  if (!text) {
    return "@mention";
  }
  return text.startsWith("@") ? text : `@${text}`;
}

export function normalizeNotificationEmailText(value: unknown): string {
  return `${value ?? ""}`.replace(USER_MENTION_SPAN, (_match, innerHtml) =>
    formatMentionText(`${innerHtml ?? ""}`),
  );
}

function normalizeNotificationMarkdown(value: unknown): string {
  return normalizeNotificationEmailText(value).replace(BR_TAG, "\n");
}

export function renderNotificationEmailMarkdownHtml(value: unknown): string {
  const source = normalizeNotificationMarkdown(value).trim();
  return markdown.render(source || "You have a CoCalc notification.");
}

export function renderNotificationEmailMarkdownText(value: unknown): string {
  return htmlFragmentToText(renderNotificationEmailMarkdownHtml(value)).trim();
}
