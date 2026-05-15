import assert from "node:assert/strict";
import test from "node:test";

import { emitError, emitSuccess, printArrayTable } from "./cli-output";

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

function withStderrCapture(fn: () => void): string {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: any[]) => {
    lines.push(args.map((x) => `${x ?? ""}`).join(" "));
  };
  try {
    fn();
  } finally {
    console.error = original;
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

test("emitSuccess left-aligns numeric-looking key-value cells", () => {
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
          objects: "882",
          db_projects: "7",
        },
      );
    }),
  );

  assert.match(output, /│ objects\s+│ 882\s+│/);
  assert.match(output, /│ db_projects\s+│ 7\s+│/);
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

test("emitError preserves fresh-auth code and prints CLI elevation hint", () => {
  const err = Object.assign(new Error("fresh auth is required"), {
    code: "fresh_auth_required",
  });

  const output = withStderrCapture(() => {
    emitError(
      {
        globals: { output: "table" },
        apiBaseUrl: "https://lite.example.test",
        accountId: "acct-1",
      },
      "host delete",
      err,
      (url) => url,
    );
  });

  assert.match(output, /fresh auth is required/);
  assert.match(output, /cocalc auth elevate/);
  assert.match(output, /passkey\/TOTP/);
});

test("emitError emits structured fresh-auth hint in json mode", () => {
  const output = withStderrCapture(() => {
    emitError(
      {
        globals: { output: "json" },
        apiBaseUrl: "https://lite.example.test",
        accountId: "acct-1",
      },
      "project move",
      new Error(
        "fresh auth is required - callHub: subject='hub.account.acct-1.api', name='projects.moveProject', code='fresh_auth_required' ",
      ),
      (url) => url,
    );
  });

  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "fresh_auth_required");
  assert.match(parsed.error.hint, /cocalc auth elevate/);
});
