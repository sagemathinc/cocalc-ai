import assert from "node:assert/strict";
import { test } from "node:test";

import { browserForwardName, existingBrowserForwards } from "./browser";

const PROJECT = "6adb0c79-a1d8-4ba3-b5cd-f0320bfedda8";

test("finds stale and live browser forwards for the same project port", () => {
  const rows = [
    { id: 1, name: browserForwardName(PROJECT, 9222, 111) }, // crashed
    { id: 2, name: browserForwardName(PROJECT, 9223, 222) }, // other port
    { id: 3, name: browserForwardName("ffffffff-0000", 9222, 333) }, // other project
    { id: 4, name: "project-6adb0c79-9222-to-9222" }, // not ours
    { id: 5, name: null },
  ];
  assert.deepEqual(
    existingBrowserForwards(rows, PROJECT, 9222, () => false),
    { stale: [1], ownerPid: null },
  );
  assert.deepEqual(
    existingBrowserForwards(rows, PROJECT, 9222, (pid) => pid === 111),
    { stale: [], ownerPid: 111 },
  );
});

test("names forwards by project, port and owning process", () => {
  assert.equal(
    browserForwardName(PROJECT, 9222, 4242),
    "cocalc-browser-6adb0c79-9222-4242",
  );
});
