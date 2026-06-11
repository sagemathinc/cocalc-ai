/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface UserFacingError {
  message: string;
  details?: string;
}

const CALL_HUB_SUFFIX = /\s*-\s*callHub:[\s\S]*$/i;
const GENERIC_ERROR_MESSAGES = new Set([
  "an error occurred",
  "error occurred",
  "something went wrong",
]);

export function normalizeUserFacingError(error: unknown): UserFacingError {
  const raw = stringifyError(error).trim();
  if (!raw) {
    return { message: "An error occurred." };
  }

  const message = readableErrorMessage(raw, error);
  const normalizedRaw = normalizeWhitespace(raw);
  const normalizedMessage = normalizeWhitespace(message);
  const hasTechnicalWrapper =
    CALL_HUB_SUFFIX.test(raw) || raw.toLowerCase().includes("callhub:");
  const hasStructuredWrapper = looksLikeStructuredErrorString(raw);
  const structuredDetails = structuredErrorDetails(error, raw);
  const normalizedStructuredDetails = normalizeWhitespace(structuredDetails);

  return {
    message,
    details:
      (hasTechnicalWrapper ||
        hasStructuredWrapper ||
        normalizedStructuredDetails !== normalizedRaw) &&
      normalizedStructuredDetails !== normalizedMessage
        ? structuredDetails
        : hasTechnicalWrapper && normalizedRaw !== normalizedMessage
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

function readableErrorMessage(raw: string, source?: unknown): string {
  if (/^callHub:/i.test(raw.trim())) {
    return "The server request failed.";
  }
  const extractedFromSource =
    source != null && typeof source === "object" && !(source instanceof Error)
      ? extractErrorMessageFromValue(source)
      : undefined;
  if (extractedFromSource && !isGenericErrorMessage(extractedFromSource)) {
    return stripLeadingErrorPrefixes(extractedFromSource);
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

function structuredErrorDetails(error: unknown, raw: string): string {
  if (!error || typeof error !== "object" || error instanceof Error) {
    return raw;
  }
  const encoded = safeJsonStringify(error);
  return encoded && encoded !== "{}" ? encoded : raw;
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
  if (value instanceof Error) {
    return extractErrorMessageFromValue(value.message);
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const genericCandidates: string[] = [];
  for (const key of ["message", "error", "reason", "stderr"]) {
    const extracted = extractErrorMessageFromValue(record[key]);
    if (!extracted) continue;
    if (!isGenericErrorMessage(extracted)) return extracted;
    genericCandidates.push(extracted);
  }
  for (const key of ["event", "detail", "details", "result"]) {
    const extracted = extractErrorMessageFromValue(record[key]);
    if (!extracted) continue;
    if (!isGenericErrorMessage(extracted)) return extracted;
    genericCandidates.push(extracted);
  }
  return genericCandidates[0];
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

function looksLikeStructuredErrorString(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function isGenericErrorMessage(value: string): boolean {
  return GENERIC_ERROR_MESSAGES.has(
    stripLeadingErrorPrefixes(value).replace(/\.+$/, "").toLowerCase(),
  );
}
