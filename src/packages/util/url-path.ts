/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function joinUrlPath(
  ...parts: Array<string | undefined | null>
): string {
  const filtered = parts
    .filter((part): part is string => !!part)
    .map((part) => `${part}`);

  if (filtered.length === 0) {
    return "";
  }

  const leadingSlash = filtered[0].startsWith("/");
  const segments = filtered
    .flatMap((part) => part.split("/"))
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return leadingSlash ? "/" : "";
  }

  return `${leadingSlash ? "/" : ""}${segments.join("/")}`;
}
