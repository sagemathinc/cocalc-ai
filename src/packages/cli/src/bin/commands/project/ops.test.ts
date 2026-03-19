import assert from "node:assert/strict";
import test from "node:test";

import { getMovePlacementFallbackTimeoutMs } from "./ops";

test("getMovePlacementFallbackTimeoutMs preserves the full timeout for timed out move waits", () => {
  assert.equal(
    getMovePlacementFallbackTimeoutMs(
      { status: "running", timedOut: true },
      1_800_000,
    ),
    1_800_000,
  );
});

test("getMovePlacementFallbackTimeoutMs caps explicit move failures to a short placement check", () => {
  assert.equal(
    getMovePlacementFallbackTimeoutMs(
      { status: "failed", timedOut: false },
      1_800_000,
    ),
    10_000,
  );
});

test("getMovePlacementFallbackTimeoutMs respects shorter command timeouts", () => {
  assert.equal(
    getMovePlacementFallbackTimeoutMs(
      { status: "failed", timedOut: false },
      5_000,
    ),
    5_000,
  );
});
