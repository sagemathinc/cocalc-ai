/*
028 B-2 (ops0 3707, SA 3420, ops3): during tests the data dir and the persist
streams' sync root (syncFiles.local) are this test process's own temporary
directories, never the checkout's {root}/data, which on a developer box may be
a live dev server's data.  backend/test/setup.js (a jest setupFiles script,
so before any test imports @cocalc/backend/data) sets COCALC_DATA_DIR and
COCALC_SYNC when they are unset.  A COCALC_SYNC preset to a path outside the
temporary directory fails here: an explicit opt-in, never a silent default.
*/

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { data, syncFiles } from "@cocalc/backend/data";

const tmp = realpathSync(tmpdir()) + "/";

describe("028 B-2: the test data and sync roots", () => {
  it("syncFiles.local is COCALC_SYNC, under the temporary directory (realpath, with a trailing-slash prefix)", () => {
    expect(process.env.COCALC_SYNC).toBeTruthy();
    expect(syncFiles.local).toBe(process.env.COCALC_SYNC);
    expect(realpathSync(syncFiles.local).startsWith(tmp)).toBe(true);
  });
  it("the data dir is under the temporary directory too", () => {
    expect(realpathSync(data).startsWith(tmp)).toBe(true);
  });
});
