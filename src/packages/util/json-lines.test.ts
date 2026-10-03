import { PassThrough, Readable } from "stream";
import * as readline from "readline";
import { createGunzip } from "zlib";
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
  expectReaderDetached(input);
});

function expectReaderDetached(input: NodeJS.ReadableStream) {
  for (const event of ["data", "end", "close", "error"]) {
    expect(input.listenerCount(event)).toBe(0);
  }
}

test("input errors reject all pending and subsequent iterator reads", async () => {
  const input = new PassThrough();
  const reader = createJsonLineReader(input);
  const iterator = reader[Symbol.asyncIterator]();
  const error = new Error("read failed");
  const pending = [
    expect(iterator.next()).rejects.toBe(error),
    expect(iterator.next()).rejects.toBe(error),
  ];
  const onClose = jest.fn();
  reader.on("close", onClose);
  input.write('{"incomplete":');
  input.destroy(error);

  await Promise.all(pending);
  await expect(iterator.next()).rejects.toBe(error);
  expect(onClose).toHaveBeenCalledTimes(1);
  expectReaderDetached(input);
  reader.close();
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("for-await rejects errors arriving between reads instead of draining buffered lines", async () => {
  const error = new Error("read failed after a line");
  const input = new PassThrough();
  const reader = createJsonLineReader(input);
  const seen: string[] = [];
  const reading = (async () => {
    for await (const line of reader) {
      seen.push(line);
      input.emit("error", error);
    }
  })();
  input.write("first\nqueued\npartial");
  await expect(reading).rejects.toBe(error);
  expect(seen).toEqual(["first"]);
  expectReaderDetached(input);
  input.destroy();
});

test("decompression errors reject async iteration", async () => {
  const input = createGunzip();
  const reader = createJsonLineReader(input);
  const reading = (async () => {
    for await (const _line of reader) {
      throw new Error("unexpected line");
    }
  })();
  const rejected = expect(reading).rejects.toMatchObject({
    code: "Z_DATA_ERROR",
  });
  input.end("not gzip data");
  await rejected;
  expectReaderDetached(input);
});

test("event consumers receive errors without flushing a partial line", () => {
  const input = new PassThrough();
  const reader = createJsonLineReader(input);
  const onLine = jest.fn();
  const onError = jest.fn();
  const onClose = jest.fn();
  reader.on("line", onLine);
  reader.on("error", onError);
  reader.on("close", onClose);
  input.write("partial");
  const error = new Error("read failed");
  input.emit("error", error);
  expect(onError).toHaveBeenCalledWith(error);
  expect(onLine).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
  expectReaderDetached(input);
  input.destroy();
});

test("close settles pending reads and preserves caller-owned listeners", async () => {
  const input = new PassThrough();
  const onError = jest.fn();
  input.on("error", onError);
  const reader = createJsonLineReader(input);
  const iterator = reader[Symbol.asyncIterator]();
  const pending = iterator.next();
  reader.close();
  await expect(pending).resolves.toEqual({ done: true });
  expect(input.listeners("error")).toEqual([onError]);
  input.removeListener("error", onError);
  expectReaderDetached(input);
  input.destroy();
});

test("breaking async iteration detaches the reader", async () => {
  const input = new PassThrough();
  input.write("first\nsecond\n");
  const reader = createJsonLineReader(input);
  for await (const line of reader) {
    expect(line).toBe("first");
    break;
  }
  expectReaderDetached(input);
  input.destroy();
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
