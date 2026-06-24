/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const MAX_DISPLAY_NAME_LENGTH = 254;

export function normalizeDisplayName(value?: string | null): string {
  return `${value ?? ""}`
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
}

export function displayNameFromParts({
  first_name,
  last_name,
}: {
  first_name?: string | null;
  last_name?: string | null;
}): string {
  return normalizeDisplayName(
    [first_name, last_name]
      .map((part) => `${part ?? ""}`.trim())
      .filter(Boolean)
      .join(" "),
  );
}

export function displayNameFromAccount(
  account?: {
    display_name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  } | null,
): string {
  return (
    normalizeDisplayName(account?.display_name) ||
    displayNameFromParts({
      first_name: account?.first_name,
      last_name: account?.last_name,
    })
  );
}

export function legacyNamePartsFromDisplayName(display_name?: string | null): {
  first_name: string;
  last_name: string;
} {
  const normalized = normalizeDisplayName(display_name);
  if (!normalized) {
    return { first_name: "", last_name: "" };
  }
  const parts = normalized.split(" ");
  return {
    first_name: parts.shift() ?? normalized,
    last_name: parts.join(" "),
  };
}

export function legacyNamePartsFromAccount(
  account?: {
    display_name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  } | null,
): {
  first_name: string;
  last_name: string;
} {
  return legacyNamePartsFromDisplayName(displayNameFromAccount(account));
}
