import { ConatError, isValidSubjectWithoutWildcards } from "../util";
import type { Headers } from "./client";

export const REPLY_HEADER = "CN-Reply";
export const MAX_MESSAGE_HEADER_BYTES = 100_000;
export const MAX_MESSAGE_HEADER_ENTRIES = 128;
export const MAX_MESSAGE_HEADER_DEPTH = 8;

function invalid(reason: string): never {
  // Do not include untrusted header values in the error or logs.
  throw new ConatError(`invalid message headers: ${reason}`, { code: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function validateReplySubject(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isValidSubjectWithoutWildcards(value)) {
    invalid("CN-Reply must be a non-wildcard subject");
  }
}

// Check before stamping/routing. Walk only a bounded number of entries, and
// reject long strings before serializing them; never stringify the whole input
// or spread it into a new object to find out whether it is acceptable.
export function validateMessageHeaders(
  value: unknown,
): asserts value is Headers | null | undefined {
  if (value == null) return;
  if (!isRecord(value)) invalid("expected a plain JSON object");
  let remaining = MAX_MESSAGE_HEADER_BYTES;
  let entries = 0;
  const spend = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) invalid("serialized byte limit exceeded");
  };
  const entry = () => {
    if (++entries > MAX_MESSAGE_HEADER_ENTRIES) invalid("entry limit exceeded");
  };
  const string = (s: string) => {
    if (s.length > remaining) invalid("serialized byte limit exceeded");
    spend(Buffer.byteLength(JSON.stringify(s)));
  };
  const visit = (item: unknown, depth: number) => {
    if (depth > MAX_MESSAGE_HEADER_DEPTH) invalid("depth limit exceeded");
    if (item === null) {
      spend(4);
      return;
    }
    switch (typeof item) {
      case "string":
        string(item);
        return;
      case "boolean":
        spend(item ? 4 : 5);
        return;
      case "number":
        if (!Number.isFinite(item)) invalid("expected a finite JSON number");
        spend(JSON.stringify(item).length);
        return;
      case "object": {
        spend(2);
        let first = true;
        if (Array.isArray(item)) {
          for (const child of item) {
            entry();
            if (!first) spend(1);
            first = false;
            visit(child, depth + 1);
          }
          return;
        }
        if (!isRecord(item)) invalid("expected JSON values");
        for (const key in item) {
          if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
          entry();
          if (!first) spend(1);
          first = false;
          string(key);
          spend(1);
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
          if (!Object.prototype.hasOwnProperty.call(descriptor, "value"))
            invalid("accessors are not JSON values");
          visit(descriptor.value, depth + 1);
        }
        return;
      }
      default:
        invalid("expected JSON values");
    }
  };
  visit(value, 0);
  if (Object.prototype.hasOwnProperty.call(value, REPLY_HEADER))
    validateReplySubject(value[REPLY_HEADER]);
}
