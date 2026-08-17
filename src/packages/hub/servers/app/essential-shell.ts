/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export function renderEssentialShell(
  html: string,
  staticBasePath: string,
): string {
  const base = staticBasePath.endsWith("/")
    ? staticBasePath
    : `${staticBasePath}/`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head) throw new Error("Essential frontend shell has no head element");
  const insertion = head.index + head[0].length;
  return `${html.slice(0, insertion)}<base href="${base}">${html.slice(insertion)}`;
}
