/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Canonical JSON and hashing for C7 input envelopes (S6a §2.2). The same
// bytes must hash the same in every process, so keys are sorted, there is no
// whitespace, and values that JSON can't round-trip are refused rather than
// silently dropped or rewritten.

import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

function encode(value: unknown, where: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJson: non-finite number at ${where}`);
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          // a sparse array's hole has no JSON form: refuse it
          if (!(i in value)) {
            throw new Error(`canonicalJson: array hole at ${where}[${i}]`);
          }
          items.push(encode(value[i], `${where}[${i}]`));
        }
        return `[${items.join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(`canonicalJson: non-plain object at ${where}`);
      }
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        // a getter could give a different value on another traversal
        if (Object.getOwnPropertyDescriptor(record, key)?.get != null) {
          throw new Error(
            `canonicalJson: accessor property at ${where}.${key}`,
          );
        }
      }
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      return `{${keys
        .map(
          (key) =>
            `${JSON.stringify(key)}:${encode(record[key], `${where}.${key}`)}`,
        )
        .join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value} at ${where}`);
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
