import assert from "node:assert/strict";
import test from "node:test";

import { emitSuccess, printArrayTable } from "./cli-output";

function withConsoleCapture(fn: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: any[]) => {
    lines.push(args.map((x) => `${x ?? ""}`).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

function withStdoutColumns<T>(columns: number, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: columns,
  });
  try {
    return fn();
  } finally {
    if (desc) {
      Object.defineProperty(process.stdout, "columns", desc);
    } else {
      delete (process.stdout as any).columns;
    }
  }
}

test("emitSuccess wraps oversized key-value cells into continuation rows", () => {
  const output = withStdoutColumns(60, () =>
    withConsoleCapture(() => {
      emitSuccess(
        {
          globals: { output: "table" },
          apiBaseUrl: "http://localhost:13004",
          accountId: "acct-1",
        },
        "demo",
        {
          foo: "x".repeat(120),
        },
      );
    }),
  );

  const maxLineLength = output
    .split("\n")
    .reduce((max, line) => Math.max(max, line.length), 0);
  assert.ok(maxLineLength <= 64, `line too wide: ${maxLineLength}`);
  assert.match(output, /foo/);
  assert.ok(!output.includes("x".repeat(120)));
});

test("printArrayTable wraps oversized multi-column cells generically", () => {
  const output = withStdoutColumns(70, () =>
    withConsoleCapture(() => {
      printArrayTable([
        {
          name: "row-1",
          payload: "abcdefghijklmnopqrstuvwxyz".repeat(6),
        },
      ]);
    }),
  );

  const maxLineLength = output
    .split("\n")
    .reduce((max, line) => Math.max(max, line.length), 0);
  assert.ok(maxLineLength <= 74, `line too wide: ${maxLineLength}`);
  assert.match(output, /row-1/);
  assert.ok(!output.includes("abcdefghijklmnopqrstuvwxyz".repeat(6)));
});
