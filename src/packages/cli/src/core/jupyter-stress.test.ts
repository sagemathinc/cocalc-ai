import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateStressRunInvariants,
  JUPYTER_STRESS_PRESET_CODE,
  normalizeExecCount,
  resolveJupyterStressCode,
  summarizeOutput,
} from "./jupyter-stress";

test("resolveJupyterStressCode prefers explicit code over presets", () => {
  assert.equal(
    resolveJupyterStressCode({ code: "print(1)", preset: "stress" }),
    "print(1)",
  );
  assert.equal(
    resolveJupyterStressCode({ preset: "smoke" }),
    JUPYTER_STRESS_PRESET_CODE.smoke,
  );
});

test("normalizeExecCount only accepts integers", () => {
  assert.equal(normalizeExecCount(7), 7);
  assert.equal(normalizeExecCount(7.1), null);
  assert.equal(normalizeExecCount(null), null);
  assert.equal(normalizeExecCount("7"), null);
});

test("summarizeOutput detects null output entries", () => {
  assert.deepEqual(summarizeOutput(null), {
    present: false,
    entries: 0,
    bytes: 0,
    signature: null,
    has_null_entry: false,
  });
  const summary = summarizeOutput({
    0: { output_type: "stream", text: "abc" },
    1: null,
  });
  assert.equal(summary.present, true);
  assert.equal(summary.entries, 2);
  assert.equal(summary.has_null_entry, true);
});

test("evaluateStressRunInvariants enforces prompt progression and stability", () => {
  const stable = summarizeOutput({ 0: { text: "ok" } });
  assert.deepEqual(
    evaluateStressRunInvariants({
      prev_exec_count: 12,
      next_exec_count: 13,
      runtime_state: "done",
      output_after: stable,
      output_after_settle: stable,
    }),
    [],
  );

  assert.deepEqual(
    evaluateStressRunInvariants({
      prev_exec_count: 12,
      next_exec_count: 0,
      runtime_state: "busy",
      output_after: summarizeOutput(null),
      output_after_settle: summarizeOutput({ 0: null }),
    }),
    [
      "execution_count is 0",
      "runtime state is 'busy', expected 'done'",
      "output missing after completion",
      "output contains null entries after settle",
    ],
  );

  assert.deepEqual(
    evaluateStressRunInvariants({
      prev_exec_count: 12,
      next_exec_count: 15,
      runtime_state: "done",
      output_after: summarizeOutput({ 0: { text: "a" } }),
      output_after_settle: summarizeOutput({ 0: { text: "b" } }),
    }),
    [
      "execution_count 15 is not previous + 1 (13)",
      "output changed after settle",
    ],
  );
});
