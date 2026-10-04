const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  diagnosticError,
  HarnessStderrDiagnostics,
  recordHarnessDiagnostic,
} = require("../../dist/acp/harness-diagnostics.js");
const logger = require("@cocalc/backend/logger").default(
  "ai:acp:harness-diagnostics",
);

test("error projection retains useful nested codes but no arbitrary text", () => {
  const error = Object.assign(
    new Error("private prompt Bearer secret ECONNRESET"),
    {
      code: -32603,
      data: {
        error: {
          type: "rate_limit_error",
          status: 429,
          message: "token=secret",
        },
      },
    },
  );
  error.cause = error;
  const result = diagnosticError(error);
  assert.deepEqual(result.protocol_codes, [-32603]);
  assert.deepEqual(result.http_statuses, [429]);
  assert.deepEqual(result.signals.sort(), ["connection_reset", "rate_limit"]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /private|prompt|Bearer|secret|token=/,
  );
});

test("unknown output is omitted, including credentials split across chunks", () => {
  const tail = new HarnessStderrDiagnostics();
  tail.append("Authorization: Bea");
  tail.append(
    "rer very-private\nCookie: session=secret\nuser prompt contents\n",
  );
  assert.deepEqual(tail.snapshot().signals, []);
  assert.doesNotMatch(
    JSON.stringify(tail.snapshot()),
    /very-private|secret|contents/,
  );
});

test("bounded stderr tail recognizes signals across chunks and releases raw bytes", () => {
  const tail = new HarnessStderrDiagnostics();
  tail.append("secret".repeat(100000));
  tail.append("\nFATAL ERROR: JavaScript heap out of mem");
  tail.append("ory\n");
  assert.equal(tail.tail.length, 16 * 1024);
  assert.equal(tail.snapshot().truncated, true);
  assert.deepEqual(tail.snapshot().signals, ["out_of_memory"]);
  const buffer = tail.tail;
  tail.seal();
  assert.ok(buffer.every((byte) => byte === 0));
  assert.equal(tail.tail.length, 0);
  tail.append("ECONNRESET");
  assert.deepEqual(tail.snapshot().signals, ["out_of_memory"]);
});

test("error traversal is bounded and does not invoke accessors or toJSON", () => {
  const error = {
    toJSON() {
      throw Error("do not call");
    },
  };
  Object.defineProperty(error, "message", {
    get() {
      throw Error("do not call");
    },
  });
  error.data = error;
  assert.deepEqual(diagnosticError(error), {
    signals: [],
    protocol_codes: [],
    http_statuses: [],
    reported_exit_codes: [],
  });
  assert.deepEqual(
    diagnosticError({
      status: 999,
      code: 123,
      message: "x".repeat(20000) + "ECONNRESET",
    }).signals,
    [],
  );
});

test("stderr includes only explicitly labelled status and exit codes", () => {
  const tail = new HarnessStderrDiagnostics();
  tail.append(
    "HTTP 503 secret; status code: 429; Claude Code process exited with code 137; secret digits 401 123456",
  );
  assert.deepEqual(tail.snapshot().http_statuses, [503, 429]);
  assert.deepEqual(tail.snapshot().reported_exit_codes, [137]);
  assert.deepEqual(tail.snapshot().signals, ["process_exit"]);
});

test("one bounded operator record correlates by unique id without raw errors", (t) => {
  const records = [];
  t.mock.method(logger, "warn", (...args) => records.push(args));
  const input = {
    method: "session/prompt",
    projectId: "00000000-0000-4000-8000-000000000001",
    accountId: "00000000-0000-4000-8000-000000000002",
    sessionId: "malicious\nsecret",
    elapsedMs: 25,
    protocolRejection: true,
    error: {
      code: -32603,
      message: "secret",
      data: { status: 503, message: "overloaded" },
    },
    stderr: new HarnessStderrDiagnostics(),
  };
  input.stderr.append("private text ETIMEDOUT");
  const id = recordHarnessDiagnostic(input);
  assert.notEqual(recordHarnessDiagnostic(input), id);
  const record = JSON.parse(records[0][1]);
  assert.equal(record.diagnostic_id, id);
  assert.equal(record.project_id, input.projectId);
  assert.equal(record.session_id, undefined);
  assert.equal(record.method, "session/prompt");
  assert.deepEqual(record.error.http_statuses, [503]);
  assert.deepEqual(record.stderr.signals, ["timeout"]);
  assert.doesNotMatch(records[0][1], /secret|private|malicious/);
});

test("logging failure does not replace the original failure or prevent cleanup", (t) => {
  t.mock.method(logger, "warn", () => {
    throw Error("logging unavailable");
  });
  const stderr = new HarnessStderrDiagnostics();
  stderr.append("private text");
  assert.match(
    recordHarnessDiagnostic({
      method: "initialize",
      projectId: "p",
      accountId: "a",
      elapsedMs: 0,
      protocolRejection: false,
      error: Error("secret"),
      stderr,
    }),
    /^[0-9a-f-]{36}$/,
  );
  assert.equal(stderr.tail.length, 0);
});

test("method vocabulary is enforced at the logging boundary", (t) => {
  const records = [];
  t.mock.method(logger, "warn", (_label, json) =>
    records.push(JSON.parse(json)),
  );
  recordHarnessDiagnostic({
    method: "session/prompt\nBearer private-token",
    projectId: "p",
    accountId: "a",
    elapsedMs: 0,
    protocolRejection: false,
    error: null,
    stderr: new HarnessStderrDiagnostics(),
  });
  assert.equal(records[0].method, "unknown");
  assert.doesNotMatch(JSON.stringify(records), /Bearer|private-token/);
});
