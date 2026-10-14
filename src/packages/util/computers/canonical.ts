/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Canonical JSON for everything the computers protocol signs or hashes
// (policies, pairing transcripts, certificates, attestations, tickets).
// Plan: src/.agents/computers-plan-2026-10-11.md
//
// Two parties must turn the same value into the same bytes, so the encoding
// is deliberately narrow: strings, safe integers, booleans, null, arrays and
// plain objects. Object keys are sorted by UTF-16 code units (as in RFC 8785).
// Anything ambiguous is an error rather than silently dropped or rounded:
// undefined, non-integer or unsafe numbers, -0, functions, symbols, bigints,
// non-plain objects and cycles.

export class CanonicalEncodingError extends Error {}

export function canonicalJson(value: unknown): string {
  return encode(value, new Set(), "$");
}

function encode(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new CanonicalEncodingError(
          `${path}: only safe integers can be encoded`,
        );
      }
      return String(value);
    case "object":
      break;
    default:
      throw new CanonicalEncodingError(
        `${path}: ${typeof value} can't be encoded`,
      );
  }
  const object = value as object;
  if (seen.has(object)) {
    throw new CanonicalEncodingError(`${path}: cycle`);
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item, i) => encode(item, seen, `${path}[${i}]`)).join(",")}]`;
    }
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalEncodingError(
        `${path}: only plain objects can be encoded`,
      );
    }
    const keys = Object.keys(object).sort(compareUtf16);
    const parts: string[] = [];
    for (const key of keys) {
      const item = (object as Record<string, unknown>)[key];
      if (item === undefined) {
        throw new CanonicalEncodingError(
          `${path}.${key}: undefined can't be encoded`,
        );
      }
      parts.push(
        `${JSON.stringify(key)}:${encode(item, seen, `${path}.${key}`)}`,
      );
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The exact bytes that get signed for one kind of object. */
export function signingInput(kind: string, payload: unknown): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(kind)) {
    throw new CanonicalEncodingError(`invalid signing kind '${kind}'`);
  }
  // Domain separation: a signature over one kind can never verify as another.
  return `cocalc-computers\u0000v1\u0000${kind}\u0000${canonicalJson(payload)}`;
}
