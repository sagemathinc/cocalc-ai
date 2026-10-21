import {
  DOCUMENT_MAX_DEPTH,
  DocumentScan,
  MAX_WHITESPACE_RUN,
  isJsonObjectLines,
  isJsonObjectLinesAsync,
} from "./json-scan";

// The scan resumed after every few characters: the same verdict.
function stepped(text: string, chars: number): boolean {
  const scan = new DocumentScan(text);
  for (let k = 0; k < 10 * text.length + 10; k++) {
    const verdict = scan.step(chars);
    if (verdict !== undefined) return verdict;
  }
  throw Error("the scan never finished");
}

// What the scan must agree with: JSON.parse of each non-empty line.
function reference(text: string): boolean {
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let x: unknown;
    try {
      x = JSON.parse(line);
    } catch {
      return false;
    }
    if (x == null || typeof x !== "object" || Array.isArray(x)) return false;
  }
  return true;
}

test("documents, and what isn't one", () => {
  for (const good of [
    "",
    "\n\n",
    "{}",
    ' {"a" : [1, -2.5e+3, true, false, null, "x\\u00e9\\n"]}\r',
    '{"type":"doc"}\n{"type":"item","id":"a"}\n',
    '{"k":{"":[[],{}]}}',
  ]) {
    expect([good, isJsonObjectLines(good)]).toEqual([good, true]);
    expect(reference(good)).toBe(true);
  }
  for (const bad of [
    " ",
    "{",
    "[]",
    "1",
    '"x"',
    "null",
    "{}x",
    "{} {}",
    '{"a":01}',
    '{"a":1.}',
    '{"a":-}',
    '{"a":1e}',
    '{"a":"\t"}',
    '{"a":"\\x"}',
    '{"a":"\\u12g4"}',
    '{"a":tru}',
    '{"a",1}',
    '{"a":1,}',
    '{"a":[1,]}',
    "{'a':1}",
    '{"a":1}\n ',
  ]) {
    expect([bad, isJsonObjectLines(bad)]).toEqual([bad, false]);
    expect(reference(bad)).toBe(false);
  }
});

test("agrees with JSON.parse on 20,000 mutated documents", () => {
  // A seeded generator, so a failure reproduces.
  let seed = 12345;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const atoms = ["0", "-1.5e3", '"s"', '"\\u00e9"', "true", "false", "null"];
  const gen = (d: number): string => {
    const k = d > 4 ? rand(2) : rand(4);
    if (k === 0) return atoms[rand(atoms.length)];
    if (k === 1) return `"${"ab\\n"[rand(4)] ?? ""}"`;
    if (k === 2) {
      const n = rand(4);
      return `[${Array.from({ length: n }, () => gen(d + 1)).join(",")}]`;
    }
    const n = rand(4);
    return `{${Array.from({ length: n }, (_, j) => `"k${j}":${gen(d + 1)}`).join(",")}}`;
  };
  const noise = ' \t\r\n{}[]",:\\-+.0123456789eEtrufalsn\u0001xé';
  let disagreements: string[] = [];
  let valid = 0;
  for (let t = 0; t < 20_000; t++) {
    const lines = Array.from({ length: 1 + rand(3) }, () =>
      rand(5) === 0 ? "" : `{"v":${gen(1)}}`,
    );
    let text = lines.join("\n");
    // Mutate most of them: insert, delete or replace a character.
    for (let m = rand(3); m > 0; m--) {
      const at = rand(text.length + 1);
      const ch = noise[rand(noise.length)];
      const op = rand(3);
      text =
        op === 0
          ? text.slice(0, at) + ch + text.slice(at)
          : op === 1
            ? text.slice(0, at) + text.slice(at + 1)
            : text.slice(0, at) + ch + text.slice(at + 1);
    }
    const expected = reference(text);
    if (expected) valid += 1;
    if (
      isJsonObjectLines(text) !== expected ||
      stepped(text, 1) !== expected ||
      stepped(text, 7) !== expected
    ) {
      disagreements.push(text);
    }
  }
  expect(disagreements).toEqual([]);
  // Both outcomes were exercised.
  expect(valid).toBeGreaterThan(2_000);
  expect(valid).toBeLessThan(18_000);
});

test("whitespace runs at most MAX_WHITESPACE_RUN long", () => {
  const spaced = (k: number) => `{${" ".repeat(k)}"a":1}`;
  expect(isJsonObjectLines(spaced(MAX_WHITESPACE_RUN))).toBe(true);
  expect(isJsonObjectLines(spaced(MAX_WHITESPACE_RUN + 1))).toBe(false);
  for (const at of [
    "{X}",
    '{"a"X:1}',
    '{"a":X1}',
    '{"a":1X}',
    '{"a":[1,X2]}',
    "X{}",
    "{}X",
  ]) {
    const text = at.replace("X", " ".repeat(MAX_WHITESPACE_RUN + 1));
    expect([at, isJsonObjectLines(text)]).toEqual([at, false]);
    expect([at, isJsonObjectLines(at.replace("X", " "))]).toEqual([at, true]);
  }
});

test(`containers nest at most ${DOCUMENT_MAX_DEPTH} deep`, () => {
  const nested = (d: number) =>
    '{"a":' + "[".repeat(d - 1) + "]".repeat(d - 1) + "}";
  expect(isJsonObjectLines(nested(DOCUMENT_MAX_DEPTH))).toBe(true);
  expect(isJsonObjectLines(nested(DOCUMENT_MAX_DEPTH + 1))).toBe(false);
  // Deep enough to overflow an unbounded recursion: refused, not thrown.
  expect(isJsonObjectLines(nested(1_000_000))).toBe(false);
});

test("a 7 MiB line of tiny members: one pass, no object graph", () => {
  const parts: string[] = [];
  let n = 0;
  for (let i = 0; n < 7 * 1024 * 1024; i++) {
    const p = `"k${i}":[0,{},[]]`;
    parts.push(p);
    n += p.length + 1;
  }
  const text = `{${parts.join(",")}}`;
  const t0 = Date.now();
  expect(isJsonObjectLines(text)).toBe(true);
  // (JSON.parse of this took about 220 ms and 90 MiB.)
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("the async scan yields between slices and agrees", async () => {
  const text = `{"a":[${"0,".repeat(2_000_000)}0]}`;
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 0);
  try {
    expect(await isJsonObjectLinesAsync(text)).toBe(true);
    expect(await isJsonObjectLinesAsync(text + "x")).toBe(false);
  } finally {
    clearInterval(timer);
  }
  // The event loop ran meanwhile (4 MB in 256 KiB slices: ~16 yields).
  expect(ticks).toBeGreaterThan(0);
});
