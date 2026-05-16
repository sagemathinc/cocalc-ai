import assert from "node:assert/strict";
import test from "node:test";

import { assertProjectTerminalRuntimeAvailable } from "./terminal";

test("assertProjectTerminalRuntimeAvailable rejects known non-runtime states", () => {
  assert.doesNotThrow(() =>
    assertProjectTerminalRuntimeAvailable({ project: { state: null } }),
  );
  assert.doesNotThrow(() =>
    assertProjectTerminalRuntimeAvailable({
      project: { state: { state: "running" } },
    }),
  );
  assert.throws(
    () =>
      assertProjectTerminalRuntimeAvailable({
        project: { state: { state: "opened" } },
      }),
    /project terminal operations are unavailable because the project is opened/,
  );
});
