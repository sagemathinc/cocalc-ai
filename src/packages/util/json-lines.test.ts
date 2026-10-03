import { PassThrough, Readable } from "stream";
import * as readline from "readline";
import { createJsonLineReader, stringifyJsonLine } from "./json-lines";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

function linesOf(chunks: (string | Buffer)[]): Promise<string[]> {
  const reader = createJsonLineReader(Readable.from(chunks));
  const lines: string[] = [];
  reader.on("line", (line) => lines.push(line));
  return new Promise((resolve) => reader.on("close", () => resolve(lines)));
}

test("keeps U+2028/U+2029 inside a JSON line, unlike readline", async () => {
  const message = JSON.stringify({ id: 1, text: `a${LS}b${PS}c` });
  expect(message.includes(LS)).toBe(true);
  // The bug being fixed: readline splits this message into fragments.
  const viaReadline: string[] = [];
  const rl = readline.createInterface({
    input: Readable.from([message + "\n"]),
  });
  rl.on("line", (line) => viaReadline.push(line));
  await new Promise((resolve) => rl.on("close", resolve));
  expect(viaReadline.length).toBeGreaterThan(1);

  const lines = await linesOf([message + "\n"]);
  expect(lines).toEqual([message]);
  expect(JSON.parse(lines[0]).text).toBe(`a${LS}b${PS}c`);
});

test("handles CRLF, multi-byte characters split across chunks, and a final unterminated line", async () => {
  const text = Buffer.from('{"x":"é😀"}\r\n{"y":2}', "utf8");
  const chunks = Array.from(text).map((byte) => Buffer.from([byte]));
  expect(await linesOf(chunks)).toEqual(['{"x":"é😀"}', '{"y":2}']);
});

test("supports async iteration and close()", async () => {
  const input = new PassThrough();
  const reader = createJsonLineReader(input);
  input.write("one\ntwo\n");
  input.end("three");
  const seen: string[] = [];
  for await (const line of reader) seen.push(line);
  expect(seen).toEqual(["one", "two", "three"]);
});

test("drops oversize lines instead of buffering without bound", async () => {
  const reader = createJsonLineReader(
    Readable.from(["x".repeat(50) + "\nok\n"]),
    {
      maxLineLength: 10,
    },
  );
  const lines: string[] = [];
  const oversize: number[] = [];
  reader.on("line", (line) => lines.push(line));
  reader.on("oversize", (n) => oversize.push(n));
  await new Promise((resolve) => reader.on("close", resolve));
  expect(lines).toEqual(["ok"]);
  expect(oversize).toEqual([50]);
});

test("stringifyJsonLine escapes the separators and round-trips", () => {
  const value = { text: `a${LS}b${PS}c` };
  const line = stringifyJsonLine(value);
  expect(line.includes(LS) || line.includes(PS)).toBe(false);
  expect(JSON.parse(line)).toEqual(value);
});
