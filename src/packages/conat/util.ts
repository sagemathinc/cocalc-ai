import jsonStableStringify from "json-stable-stringify";
import { encode as encodeBase64, decode as decodeBase64 } from "js-base64";
export { encodeBase64, decodeBase64 };
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";

// Only protocol-safe error metadata may cross a service boundary.
export function serviceErrorAttributes(value: unknown): {
  code?: string | number;
  retry_after_ms?: number;
} {
  const result: { code?: string | number; retry_after_ms?: number } = {};
  if (value == null || typeof value !== "object") return result;
  const { code, retry_after_ms } = value as Record<string, unknown>;
  if (
    (typeof code === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(code)) ||
    (typeof code === "number" && Number.isSafeInteger(code))
  ) {
    result.code = code;
  }
  if (
    typeof retry_after_ms === "number" &&
    Number.isSafeInteger(retry_after_ms) &&
    retry_after_ms >= 0
  ) {
    result.retry_after_ms = retry_after_ms;
  }
  return result;
}

export class ConatError extends Error {
  code?: string | number;
  subject?: string;
  retry_after_ms?: number;
  constructor(
    mesg: string,
    {
      code,
      subject,
      retry_after_ms,
    }: {
      code?: string | number;
      subject?: string;
      retry_after_ms?: number;
    } = {},
  ) {
    super(mesg);
    this.code = code;
    this.subject = subject;
    if (retry_after_ms !== undefined) this.retry_after_ms = retry_after_ms;
  }
}

function conatErrorMessage(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  try {
    const message = (value as any)?.message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  } catch {
    // Malformed proxy objects should still produce a usable protocol error.
  }
  return "Conat request failed";
}

export function headerToError(headers): ConatError {
  const err = new ConatError(conatErrorMessage(headers?.error));
  if (headers?.error_attrs) {
    for (const field of Object.keys(headers.error_attrs)) {
      err[field] = headers.error_attrs[field];
    }
  }
  if (!err.message?.trim()) {
    err.message = conatErrorMessage(headers?.error);
  }
  if (err["code"] === undefined && headers?.code != null) {
    err["code"] = headers.code;
  }
  return err;
}

export function handleErrorMessage(mesg) {
  if (mesg?.error) {
    if (mesg.error.startsWith("Error: ")) {
      throw Error(mesg.error.slice("Error: ".length));
    } else {
      throw Error(mesg.error);
    }
  }
  return mesg;
}

// Returns true if the subject matches the NATS pattern.
export function matchesPattern({
  pattern,
  subject,
}: {
  pattern: string;
  subject: string;
}): boolean {
  const subParts = subject.split(".");
  const patParts = pattern.split(".");
  let i = 0,
    j = 0;
  while (i < subParts.length && j < patParts.length) {
    if (patParts[j] === ">") return true;
    if (patParts[j] !== "*" && patParts[j] !== subParts[i]) return false;
    i++;
    j++;
  }

  return i === subParts.length && j === patParts.length;
}

// Return true if the subject is a valid NATS subject.
// Returns true if the subject is a valid NATS subject (UTF-8 aware)
export function isValidSubject(subject: string): boolean {
  if (typeof subject !== "string" || subject.length === 0) return false;
  if (subject.startsWith(".") || subject.endsWith(".")) return false;
  const tokens = subject.split(".");
  // No empty tokens
  if (tokens.some((t) => t.length === 0)) return false;
  for (let i = 0; i < tokens.length; ++i) {
    const tok = tokens[i];
    // ">" is only allowed as last token
    if (tok === ">" && i !== tokens.length - 1) return false;
    // "*" and ">" are allowed as sole tokens
    if (tok !== "*" && tok !== ">") {
      // Must not contain "." or any whitespace Unicode code point
      if (/[.\s]/u.test(tok)) {
        return false;
      }
    }
    // All tokens: must not contain whitespace (unicode aware)
    if (/\s/u.test(tok)) {
      return false;
    }
    // Allow any UTF-8 (unicode) chars except dot and whitespace in tokens.
  }
  return true;
}

export function isValidSubjectWithoutWildcards(subject: string): boolean {
  return (
    isValidSubject(subject) && !subject.includes("*") && !subject.endsWith(">")
  );
}

export function toKey(x): string | undefined {
  if (x === undefined) {
    return undefined;
  } else if (typeof x === "object") {
    return jsonStableStringify(x);
  } else {
    return `${x}`;
  }
}

// Returns the max payload size for messages for the NATS server
// that we are connected to.  This is used for chunking by the kv
// and stream to support arbitrarily large values.
export const getMaxPayload = reuseInFlight(async () => {
  // [ ] TODO
  return 1e6;
});

export const waitUntilConnected = reuseInFlight(async () => {});
