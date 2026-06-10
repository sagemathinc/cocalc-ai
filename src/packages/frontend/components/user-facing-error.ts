/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface UserFacingError {
  message: string;
  details?: string;
}

const CALL_HUB_SUFFIX = /\s*-\s*callHub:[\s\S]*$/i;

export function normalizeUserFacingError(error: unknown): UserFacingError {
  const raw = stringifyError(error).trim();
  if (!raw) {
    return { message: "An error occurred." };
  }

  const message = readableErrorMessage(raw);
  const normalizedRaw = normalizeWhitespace(raw);
  const normalizedMessage = normalizeWhitespace(message);
  const hasTechnicalWrapper =
    CALL_HUB_SUFFIX.test(raw) || raw.toLowerCase().includes("callhub:");

  return {
    message,
    details:
      hasTechnicalWrapper && normalizedRaw !== normalizedMessage
        ? raw
        : undefined,
  };
}

export function stringifyError(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    return error.message || `${error}`;
  }
  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
    const encoded = safeJsonStringify(error);
    if (encoded && encoded !== "{}") {
      return encoded;
    }
  }
  return `${error}`;
}

function readableErrorMessage(raw: string): string {
  if (/^callHub:/i.test(raw.trim())) {
    return "The server request failed.";
  }
  const withoutCallHub = stripCallHubSuffix(raw);
  const withoutPrefixes = stripLeadingErrorPrefixes(withoutCallHub);
  const parsed = parseMaybeJson(withoutPrefixes);
  const extracted =
    parsed == null ? undefined : extractErrorMessageFromValue(parsed);
  const message = stripLeadingErrorPrefixes(extracted ?? withoutPrefixes);
  if (message) {
    return message;
  }
  if (raw.toLowerCase().includes("callhub:")) {
    return "The server request failed.";
  }
  return "An error occurred.";
}

function stripCallHubSuffix(value: string): string {
  return value.replace(CALL_HUB_SUFFIX, "").trim();
}

function stripLeadingErrorPrefixes(value: string): string {
  let s = value.trim();
  for (let i = 0; i < 10; i++) {
    const next = s
      .replace(/^error\s*:\s*/i, "")
      .replace(/^error\s*-\s*/i, "")
      .trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

function extractErrorMessageFromValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = stripLeadingErrorPrefixes(stripCallHubSuffix(value));
    const parsed = parseMaybeJson(trimmed);
    if (parsed != null) {
      return extractErrorMessageFromValue(parsed);
    }
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "reason", "stderr"]) {
    const extracted = extractErrorMessageFromValue(record[key]);
    if (extracted) return extracted;
  }
  for (const key of ["event", "detail", "result"]) {
    const extracted = extractErrorMessageFromValue(record[key]);
    if (extracted) return extracted;
  }
  return undefined;
}

function parseMaybeJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
