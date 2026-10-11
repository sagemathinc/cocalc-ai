import {
  CanonicalEncodingError,
  canonicalJson,
  signingInput,
} from "./canonical";

describe("canonicalJson", () => {
  it("sorts keys at every level and has no whitespace", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [3, { y: true, x: null }], c: "s" } }),
    ).toBe('{"a":{"c":"s","d":[3,{"x":null,"y":true}]},"b":1}');
  });

  it("gives equal bytes for equal values built in different orders", () => {
    const one = {
      site: "https://cocalc.ai",
      version: 1,
      nested: { b: 2, a: 1 },
    };
    const two = {
      nested: { a: 1, b: 2 },
      version: 1,
      site: "https://cocalc.ai",
    };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  it("sorts keys by UTF-16 code units", () => {
    expect(canonicalJson({ é: 1, z: 2, Z: 3 })).toBe('{"Z":3,"z":2,"é":1}');
  });

  it("escapes strings as JSON does", () => {
    expect(canonicalJson({ s: 'a"b\\c\n\u0001' })).toBe(
      '{"s":"a\\"b\\\\c\\n\\u0001"}',
    );
  });

  it.each([
    ["a fraction", { n: 1.5 }],
    ["an unsafe integer", { n: 2 ** 53 }],
    ["negative zero", { n: -0 }],
    ["NaN", { n: NaN }],
    ["undefined", { n: undefined }],
    ["a bigint", { n: BigInt(1) }],
    ["a function", { n: () => 1 }],
    ["a Date", { n: new Date(0) }],
    ["a Map", { n: new Map() }],
  ])("refuses %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalEncodingError);
  });

  it("refuses cycles but allows repeated references", () => {
    const shared = { a: 1 };
    expect(canonicalJson({ x: shared, y: shared })).toBe(
      '{"x":{"a":1},"y":{"a":1}}',
    );
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/);
  });

  it("accepts objects without a prototype", () => {
    const o = Object.create(null);
    o.k = "v";
    expect(canonicalJson(o)).toBe('{"k":"v"}');
  });
});

describe("signingInput", () => {
  it("separates kinds, so a signature can't be reused for another kind", () => {
    const payload = { a: 1 };
    expect(signingInput("computer-ticket", payload)).not.toBe(
      signingInput("project-attestation", payload),
    );
    expect(signingInput("computer-ticket", payload)).toBe(
      'cocalc-computers\u0000v1\u0000computer-ticket\u0000{"a":1}',
    );
  });

  it("refuses odd kinds", () => {
    expect(() => signingInput("Ticket\u0000", {})).toThrow(
      CanonicalEncodingError,
    );
    expect(() => signingInput("", {})).toThrow(CanonicalEncodingError);
  });
});
