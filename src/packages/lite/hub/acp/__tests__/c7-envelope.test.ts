/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { canonicalJson, sha256Hex } from "../../sqlite/c7-envelope";

describe("canonicalJson", () => {
  it("sorts keys at every depth and has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[1,{"e":3,"f":2}]},"b":1}',
    );
  });

  it("omits undefined fields, like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("refuses what JSON can't round-trip", () => {
    const holey: unknown[] = [];
    holey[1] = 1;
    expect(() => canonicalJson(holey)).toThrow("hole");
    expect(() => canonicalJson([undefined])).toThrow();
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalJson({ d: new Date(0) })).toThrow("non-plain");
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
  });

  it("is stable under a parse round trip", () => {
    const value = { z: 'é "\\', y: [0, -1.5, true, null] };
    const text = canonicalJson(value);
    expect(canonicalJson(JSON.parse(text))).toBe(text);
    expect(sha256Hex(text)).toHaveLength(64);
  });
});

describe("canonicalJson: C1 r2 edges", () => {
  it("refuses accessor properties", () => {
    const value: any = {};
    let calls = 0;
    Object.defineProperty(value, "a", {
      enumerable: true,
      get: () => ++calls,
    });
    expect(() => canonicalJson(value)).toThrow("accessor");
    expect(calls).toBe(0);
  });

  it("orders keys by code unit, Unicode included", () => {
    expect(canonicalJson({ é: 1, z: 2, A: 3, "😀": 4 })).toBe(
      '{"A":3,"z":2,"é":1,"😀":4}',
    );
  });

  it("refuses a hole anywhere, at any depth", () => {
    const holey: unknown[] = [1];
    holey[2] = 3;
    expect(() => canonicalJson({ a: { b: holey } })).toThrow("$.a.b[1]");
  });
});
