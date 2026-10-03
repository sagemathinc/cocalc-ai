/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Newline-delimited JSON over streams, without node:readline.
//
// readline treats U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR as line
// breaks, but JSON.stringify leaves those characters raw inside strings. A
// readline-based JSON-lines reader therefore splits any message whose text
// contains them into unparseable fragments (silently dropping requests or
// corrupting records). These helpers split only on "\n".

import { EventEmitter } from "events";
import { StringDecoder } from "string_decoder";

const SEPARATORS = /[\u2028\u2029]/g;

/**
 * JSON.stringify, with U+2028/U+2029 written as escapes so the line survives
 * any reader that treats them as line breaks. The result is still valid JSON
 * and parses to the same value.
 */
export function stringifyJsonLine(value: unknown): string {
  return JSON.stringify(value).replace(SEPARATORS, (c) =>
    c === "\u2028" ? "\\u2028" : "\\u2029",
  );
}

export interface JsonLineReaderOptions {
  // Lines longer than this (in UTF-16 units) are dropped and reported through
  // the "oversize" event instead of being buffered without bound.
  maxLineLength?: number;
}

/**
 * Drop-in replacement for the parts of readline.Interface used to read
 * newline-delimited data: "line" and "close" events, close(), and async
 * iteration. Splits only on "\n" (a trailing "\r" is removed).
 */
export class JsonLineReader extends EventEmitter {
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private closed = false;
  private queue: string[] = [];
  private waiting: ((result: IteratorResult<string>) => void) | undefined;
  private iterating = false;
  private readonly onData = (chunk: Buffer | string) => this.push(chunk);
  private readonly onEnd = () => this.finish();

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly options: JsonLineReaderOptions = {},
  ) {
    super();
    // Like readline, start consuming input only once someone listens for
    // lines or starts iterating, so no early line is lost.
    this.on("newListener", (event) => {
      if (event === "line") this.start();
    });
  }

  private started = false;
  private start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.input.on("data", this.onData);
    this.input.on("end", this.onEnd);
    this.input.on("close", this.onEnd);
    this.input.on("error", (error) => {
      this.emit("error", error);
      this.finish();
    });
  }

  private push(chunk: Buffer | string) {
    if (this.closed) return;
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.deliver(line);
      if (this.closed) return;
    }
    const max = this.options.maxLineLength;
    if (max != null && this.buffer.length > max) {
      this.emit("oversize", this.buffer.length);
      this.buffer = "";
    }
  }

  private deliver(raw: string) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const max = this.options.maxLineLength;
    if (max != null && line.length > max) {
      this.emit("oversize", line.length);
      return;
    }
    if (this.iterating) {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve({ value: line, done: false });
      } else {
        this.queue.push(line);
        // Backpressure for slow consumers of large inputs.
        if (this.queue.length > 1000) this.input.pause?.();
      }
    }
    this.emit("line", line);
  }

  private finish() {
    if (this.closed) return;
    const rest = this.buffer + this.decoder.end();
    this.buffer = "";
    if (rest.length > 0) this.deliver(rest);
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
    this.input.removeListener("close", this.onEnd);
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
    this.emit("close");
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    this.iterating = true;
    this.start();
    return {
      next: () => {
        const line = this.queue.shift();
        if (line !== undefined) {
          if (this.queue.length < 100) this.input.resume?.();
          return Promise.resolve({ value: line, done: false });
        }
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

export function createJsonLineReader(
  input: NodeJS.ReadableStream,
  options?: JsonLineReaderOptions,
): JsonLineReader {
  return new JsonLineReader(input, options);
}
