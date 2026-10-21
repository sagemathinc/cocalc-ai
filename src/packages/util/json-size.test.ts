import { fromJS, List, Map as IMap, OrderedMap, Set as ISet } from "immutable";
import {
  jsonLengthCapped,
  jsonLinesLengthCapped,
  utf8LengthCapped,
} from "./json-size";

const MiB = 1024 * 1024;
const exact = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
const big = { max: 64 * MiB };

describe("jsonLengthCapped equals JSON.stringify's UTF-8 length", () => {
  const corpus: [string, unknown][] = [
    ["a string", "hello"],
    ["escapes", 'a"b\\c\n\r\t\b\f'],
    ["control characters", "\u0000\u0001\u001f\u007f"],
    ["multibyte", "é中😀"],
    ["U+2028 and U+2029 (not escaped)", "  "],
    ["a lone high surrogate", "a\ud800b"],
    ["a lone low surrogate", "a\udc00b"],
    ["surrogates out of order", "\udc00\ud800"],
    ["a lone surrogate at the end", "x\ud83d"],
    ["numbers", [0, -1, 1.5, 1e21, 1e-7, -0, 123456789.123]],
    ["NaN and Infinity", [NaN, Infinity, -Infinity]],
    ["booleans and null", [true, false, null]],
    ["empty containers", [{}, [], [[]], { a: {} }]],
    [
      "omitted members",
      { a: undefined, b: () => 1, c: Symbol("x"), d: 1, e: undefined },
    ],
    ["only omitted members", { a: undefined }],
    ["nulls in arrays", [undefined, () => 1, Symbol("x"), 1]],
    ["keys needing escapes", { 'k"\n': 1, "\ud800": 2, "é😀": 3 }],
    ["nested", { a: [1, { b: ["x", { c: null }] }], d: { e: { f: [[[]]] } } }],
    ["a null prototype object", Object.assign(Object.create(null), { a: 1 })],
  ];
  it.each(corpus)("%s", (_, value) => {
    expect(jsonLengthCapped(value, big)).toBe(exact(value));
  });

  it("an Immutable Map and List, as their toJS() is stringified", () => {
    const value = fromJS({ a: [1, "é", { b: null }], c: { d: "\ud800" } });
    expect(jsonLengthCapped(value, big)).toBe(exact(value.toJS()));
    const ordered = OrderedMap({ b: 1, a: [2] });
    expect(jsonLengthCapped(ordered, big)).toBe(exact(ordered.toJS()));
    const list = List([IMap({ x: 1 }), "y"]);
    expect(jsonLengthCapped(list, big)).toBe(exact(list.toJS()));
  });

  it("a very wide object, without listing its keys", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 1_000_000; i++) wide[`k${i}`] = i;
    const keys = jest.spyOn(Object, "keys");
    let measured: number | undefined;
    let calls: number;
    try {
      measured = jsonLengthCapped(wide, big);
      calls = keys.mock.calls.length;
    } finally {
      keys.mockRestore();
    }
    expect(calls).toBe(0);
    expect(measured).toBe(exact(wide));
  });
});

describe("jsonLengthCapped refuses rather than under-count", () => {
  class Point {
    x = 1;
  }
  const cyclic: any = { a: 1 };
  cyclic.self = cyclic;
  it.each([
    ["a Date (toJSON)", { d: new Date(0) }],
    ["an object with toJSON", { toJSON: () => "x" }],
    ["a native Map", new Map([["a", 1]])],
    ["a native Set", new Set([1])],
    ["a typed array", new Uint8Array(3)],
    ["a BigInt", { n: BigInt(1) }],
    ["a class instance", new Point()],
    ["an Immutable Set", ISet([1])],
    ["a cycle", cyclic],
    ["undefined itself", undefined],
  ])("%s", (_, value) => {
    expect(jsonLengthCapped(value, big)).toBeUndefined();
  });

  it("refuses nesting deeper than the cap, without overflowing the stack", () => {
    let deep: any = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(jsonLengthCapped(deep, big)).toBeUndefined();
    let ok: any = 1;
    for (let i = 0; i < 999; i++) ok = { a: ok };
    expect(jsonLengthCapped(ok, big)).toBe(exact(ok));
  });

  it("stops at the cap, even within a single record over 32 MiB", () => {
    const max = 32 * MiB;
    // one huge field
    const huge = { s: "x".repeat(40 * MiB) };
    expect(jsonLengthCapped(huge, { max })).toBeUndefined();
    // just under and just over
    const fits = { s: "x".repeat(100) };
    expect(jsonLengthCapped(fits, { max: exact(fits) })).toBe(exact(fits));
    expect(jsonLengthCapped(fits, { max: exact(fits) - 1 })).toBeUndefined();
    // many small members of one record
    const wide: Record<string, string> = {};
    for (let i = 0; i < 400_000; i++) wide[`k${i}`] = "y".repeat(100);
    expect(jsonLengthCapped(wide, { max })).toBeUndefined();
  });
});

describe("jsonLinesLengthCapped", () => {
  it("is the length of the records' JSON lines joined by newlines", () => {
    const records = [{ a: 1 }, undefined, { b: "é" }, null, { c: [1, 2] }];
    const lines = records
      .filter((r) => r != null)
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(jsonLinesLengthCapped(records, big)).toBe(
      Buffer.byteLength(lines, "utf8"),
    );
    expect(
      jsonLinesLengthCapped(List(records.map((r) => (r ? fromJS(r) : r))), big),
    ).toBe(Buffer.byteLength(lines, "utf8"));
    expect(jsonLinesLengthCapped([], big)).toBe(0);
  });

  it("stops at the cap, and at a record it cannot measure", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ i }));
    const total = jsonLinesLengthCapped(records, big)!;
    expect(jsonLinesLengthCapped(records, { max: total })).toBe(total);
    expect(jsonLinesLengthCapped(records, { max: total - 1 })).toBeUndefined();
    expect(
      jsonLinesLengthCapped([{ a: 1 }, { d: new Date() }], big),
    ).toBeUndefined();
  });
});

describe("utf8LengthCapped", () => {
  it.each([
    ["ascii", "hello"],
    ["multibyte", "é中😀"],
    ["a lone surrogate (as U+FFFD)", "a\ud800b"],
    ["empty", ""],
  ])("%s", (_, s) => {
    expect(utf8LengthCapped(s, 1000)).toBe(new TextEncoder().encode(s).length);
  });
  it("stops past the cap", () => {
    expect(utf8LengthCapped("€".repeat(10), 30)).toBe(30);
    expect(utf8LengthCapped("€".repeat(10), 29)).toBeUndefined();
  });
});

describe("the work is capped, not only the bytes (LIMIT-H1B2I-2)", () => {
  it("a very wide object of omitted members writes '{}' but gives up", () => {
    const wide: any = {};
    for (let i = 0; i < 200_000; i++) {
      wide[`k${i}`] = i % 3 == 0 ? undefined : i % 3 == 1 ? () => 0 : Symbol();
    }
    expect(JSON.stringify(wide)).toBe("{}");
    // within a large byte cap, the work cap (by default the byte cap) stops it
    expect(jsonLengthCapped(wide, { max: 100_000 })).toBeUndefined();
    // and with enough work allowed it measures exactly
    expect(jsonLengthCapped(wide, { max: 100_000, maxWork: 300_000 })).toBe(2);
  });

  it("an omitted-only Immutable Map", () => {
    const m = IMap(
      Array.from({ length: 50_000 }, (_, i) => [`k${i}`, undefined]),
    );
    expect(jsonLengthCapped(m, { max: 10_000 })).toBeUndefined();
  });

  it("an array of undefined is counted (null), so it fits the work cap", () => {
    const a = new Array(1000).fill(undefined);
    expect(jsonLengthCapped(a, { max: 10_000 })).toBe(JSON.stringify(a).length);
  });

  describe("a polluted prototype", () => {
    const keys: string[] = [];
    beforeAll(() => {
      for (let i = 0; i < 100_000; i++) {
        const key = `__polluted${i}`;
        (Object.prototype as any)[key] = i;
        keys.push(key);
      }
    });
    afterAll(() => {
      for (const key of keys) delete (Object.prototype as any)[key];
    });

    it("inherited keys are not written, but visiting them counts", () => {
      const small = { a: 1 };
      expect(JSON.stringify(small)).toBe('{"a":1}');
      expect(jsonLengthCapped(small, { max: 10_000 })).toBeUndefined();
      expect(jsonLengthCapped(small, { max: 10_000, maxWork: 200_000 })).toBe(
        7,
      );
    });
  });

  it("records skipped as empty count too", () => {
    const records = new Array(100_000).fill(null);
    expect(jsonLinesLengthCapped(records, { max: 1000 })).toBeUndefined();
    expect(
      jsonLinesLengthCapped([{ a: 1 }, null, { b: 2 }], { max: 1000 }),
    ).toBe(15);
  });

  it("one work cap across all records", () => {
    const record: any = {};
    for (let i = 0; i < 600; i++) record[`k${i}`] = undefined;
    // each record alone fits a 1000-step cap; 3 together do not
    expect(jsonLengthCapped(record, { max: 1000 })).toBe(2);
    expect(
      jsonLinesLengthCapped([record, record, record], { max: 1000 }),
    ).toBeUndefined();
  });
});
