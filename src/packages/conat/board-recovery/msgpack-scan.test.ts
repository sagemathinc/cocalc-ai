import { encode } from "@msgpack/msgpack";
import { scanMsgpack, type MsgpackLimits } from "./msgpack-scan";

const L: MsgpackLimits = {
  maxDepth: 4,
  maxElements: 100,
  maxStrLength: 16,
  maxBinLength: 16,
  maxArrayLength: 10,
  maxMapLength: 10,
};

const ok = (x: unknown, limits = L) =>
  expect(() => scanMsgpack(encode(x), limits)).not.toThrow();
const bad = (bytes: Uint8Array, re: RegExp, limits = L) =>
  expect(() => scanMsgpack(bytes, limits)).toThrow(re);

test("accepts values within every bound", () => {
  ok(null);
  ok(7);
  ok("short");
  ok({ a: [1, 2, { b: "x" }], c: new Uint8Array(4), d: true, e: 1.5 });
  ok([[[["four deep"]]]]);
  ok(-5);
  ok(2 ** 40);
});

test("astra's probe: 64 nested arrays in 69 bytes are refused", () => {
  let x: unknown = [];
  for (let i = 0; i < 63; i++) x = [x];
  const bytes = encode(x);
  expect(bytes.byteLength).toBeLessThanOrEqual(69);
  bad(bytes, /nested over 4 deep/);
  // At depth 1 too.
  bad(bytes, /nested over 1 deep/, { ...L, maxDepth: 1 });
});

test("depth: exactly the bound passes, one more is refused", () => {
  ok([[[[1]]]]);
  bad(encode([[[[[1]]]]]), /nested over 4 deep/);
  ok({ a: { b: { c: { d: 1 } } } });
  bad(encode({ a: { b: { c: { d: { e: 1 } } } } }), /nested over 4 deep/);
});

test("wide: a header claiming 2^32 - 1 entries fails at once", () => {
  const big = { ...L, maxArrayLength: 2 ** 32, maxMapLength: 2 ** 32 };
  // array 32 and map 32 headers with nothing after them.
  bad(Uint8Array.from([0xdd, 0xff, 0xff, 0xff, 0xff]), /over 100 items/, big);
  bad(Uint8Array.from([0xdf, 0xff, 0xff, 0xff, 0xff]), /over 100 items/, big);
  // Against the length limits first.
  bad(Uint8Array.from([0xdd, 0xff, 0xff, 0xff, 0xff]), /array of 4294967295/);
  bad(Uint8Array.from([0xdf, 0x00, 0x00, 0x00, 0x0b]), /map of 11/);
});

test("wide: many small items past the item budget", () => {
  const items = { ...L, maxArrayLength: 1000 };
  ok(Array(100).fill(0), items);
  bad(encode(Array(101).fill(0)), /over 100 items/, items);
  // A map's keys count as well as its values: 4 maps of 10 entries are
  // 4 + 80 items, 5 of them 5 + 100.
  const map: { [k: string]: number } = {};
  for (let i = 0; i < 10; i++) map[`k${i}`] = i;
  ok([map, map, map, map], items);
  bad(encode([map, map, map, map, map]), /over 100 items/, items);
});

test("long: a string or bin one byte over its cap", () => {
  ok("x".repeat(16));
  bad(encode("x".repeat(17)), /string of 17/);
  ok(new Uint8Array(16));
  bad(encode(new Uint8Array(17)), /bin of 17/);
  // A str 32 header claiming 4 GiB, with nothing after it.
  bad(Uint8Array.from([0xdb, 0xff, 0xff, 0xff, 0xff]), /string of 4294967295/);
});

test("truncation, trailing bytes, extension types and the reserved byte", () => {
  const bytes = encode({ a: "hello" });
  bad(bytes.subarray(0, bytes.byteLength - 1), /truncated/);
  const extra = new Uint8Array(bytes.byteLength + 1);
  extra.set(bytes);
  bad(extra, /1 trailing bytes/);
  bad(Uint8Array.from([0xd4, 0x01, 0x00]), /extension/); // fixext 1
  bad(Uint8Array.from([0xc7, 0x00, 0x01]), /extension/); // ext 8
  bad(Uint8Array.from([0xc1]), /reserved/);
  bad(new Uint8Array(0), /truncated/);
  // A timestamp (an extension) inside a map.
  bad(encode({ t: new Date(0) }), /extension/);
});

test("O(depth) memory: a deep but valid value at the bound scans without recursion", () => {
  // 10,000 one-element arrays (0x91) around a 1, built by hand (the encoder
  // itself stops at depth 100).
  const bytes = new Uint8Array(10_001).fill(0x91);
  bytes[10_000] = 0x01;
  expect(() =>
    scanMsgpack(bytes, { ...L, maxDepth: 10_000, maxElements: 10_000 }),
  ).not.toThrow();
});

test("astra CORR-DFC-1: the item budget is checked on every item, nested tails included", () => {
  const at = (bytes: number[], maxElements: number) =>
    scanMsgpack(Uint8Array.from(bytes), { ...L, maxElements, maxDepth: 3 });
  // [[0], 0]: 3 items (the inner array, its 0, the last 0).
  const nested = [0x92, 0x91, 0, 0];
  expect(() => at(nested, 2)).toThrow(/over 2 items/);
  expect(() => at(nested, 3)).not.toThrow();
  // {a: [0], b: 0}: keys and values (4) plus the inner 0 = 5.
  const mapTail = [...encode({ a: [0], b: 0 })];
  expect(() => at(mapTail, 4)).toThrow(/over 4 items/);
  expect(() => at(mapTail, 5)).not.toThrow();
  // [[0, 0], [0, 0]]: 6 items.
  const two = [0x92, 0x92, 0, 0, 0x92, 0, 0];
  expect(() => at(two, 5)).toThrow(/over 5 items/);
  expect(() => at(two, 6)).not.toThrow();
});
