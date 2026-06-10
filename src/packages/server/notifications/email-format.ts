/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Parser } from "htmlparser2";

const USER_MENTION_SPAN =
  /<span\b(?=[^>]*\bclass\s*=\s*(?:"[^"]*\buser-mention\b[^"]*"|'[^']*\buser-mention\b[^']*'|[^\s>]*\buser-mention\b[^\s>]*))(?=[^>]*\baccount-id\b)[^>]*>([\s\S]*?)<\/span>/gi;

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
