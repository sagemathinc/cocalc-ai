import assert from "node:assert/strict";
import test from "node:test";

import { normalizeJupyterExecInlineScriptTokens } from "./jupyter";

test("normalizeJupyterExecInlineScriptTokens strips an accidental extra exec token", () => {
  assert.equal(
    normalizeJupyterExecInlineScriptTokens(["exec", "return", "2+3"]),
    "return 2+3",
  );
});

test("normalizeJupyterExecInlineScriptTokens preserves ordinary inline javascript", () => {
  assert.equal(
    normalizeJupyterExecInlineScriptTokens(["return", "2+3"]),
    "return 2+3",
  );
});
