import { ConatError, isValidSubjectWithoutWildcards } from "../util";
import type { Headers } from "./client";

export const REPLY_HEADER = "CN-Reply";
export const MAX_MESSAGE_HEADER_BYTES = 100_000;

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

// Headers include application JSON (e.g. persistence metadata and editor maps),
// so bound serialized bytes, not arbitrary nested entry counts or depth. An
// iterative walk avoids call-stack limits and visits one child at a time. Every
// value consumes at least one byte, bounding both work and stack by the budget.
export function validateMessageHeaders(
  value: unknown,
): asserts value is Headers | null | undefined {
  if (value == null) return;
  if (!isRecord(value)) invalid("expected a plain JSON object");
  let remaining = MAX_MESSAGE_HEADER_BYTES;
  // Also bound visits to omitted undefined properties in locally constructed
  // envelopes. Every actual JSON slot costs at least a byte, so this budget
  // cannot reject JSON that fits the serialized byte limit.
  let slots = MAX_MESSAGE_HEADER_BYTES;
  const slot = () => {
    if (--slots < 0) invalid("JSON work budget exceeded");
  };
  const spend = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) invalid("serialized byte limit exceeded");
  };
  const string = (s: string) => {
    if (s.length > remaining) invalid("serialized byte limit exceeded");
    spend(Buffer.byteLength(JSON.stringify(s)));
  };
  function* children(object: object): Generator<unknown> {
    let first = true;
    if (Array.isArray(object)) {
      for (let i = 0; i < object.length; i++) {
        slot();
        if (!first) spend(1);
        first = false;
        const descriptor = Object.getOwnPropertyDescriptor(object, i);
        if (descriptor != null && !("value" in descriptor))
          invalid("accessors are not JSON values");
        yield descriptor?.value ?? null;
      }
    } else {
      for (const key in object) {
        if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
        slot();
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        if (!("value" in descriptor)) invalid("accessors are not JSON values");
        if (descriptor.value === undefined) continue;
        if (!first) spend(1);
        first = false;
        string(key);
        spend(1);
        yield descriptor.value;
      }
    }
  }
  const active = new Set<object>();
  const stack: { iterator: Iterator<unknown>; object?: object }[] = [
    { iterator: [value][Symbol.iterator]() },
  ];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const next = frame.iterator.next();
    if (next.done) {
      if (frame.object != null) active.delete(frame.object);
      stack.pop();
      continue;
    }
    const item = next.value;
    if (item === null) {
      spend(4);
      continue;
    }
    switch (typeof item) {
      case "string":
        string(item);
        break;
      case "boolean":
        spend(item ? 4 : 5);
        break;
      case "number":
        if (!Number.isFinite(item)) invalid("expected a finite JSON number");
        spend(JSON.stringify(item).length);
        break;
      case "object": {
        if (!Array.isArray(item) && !isRecord(item))
          invalid("expected JSON values");
        if (active.has(item)) invalid("cyclic values are not JSON");
        spend(2);
        active.add(item);
        stack.push({ object: item, iterator: children(item) });
        break;
      }
      default:
        invalid("expected JSON values");
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, REPLY_HEADER))
    validateReplySubject(value[REPLY_HEADER]);
}
