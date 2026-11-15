/*
028 B-2 (ops0 3707, ops3): during tests the persist streams' sync root
(syncFiles.local) is this test process's own temporary directory, never the
checkout's {root}/data/sync, which on a developer box may be a live dev
server's data.  backend/test/setup.js sets COCALC_SYNC when it is unset.
*/

import { join, relative, isAbsolute } from "node:path";
import { root, syncFiles } from "@cocalc/backend/data";

const under = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

describe("028 B-2: the test sync root", () => {
  it("syncFiles.local is COCALC_SYNC, and NOT under {root}/data", () => {
    expect(process.env.COCALC_SYNC).toBeTruthy();
    expect(syncFiles.local).toBe(process.env.COCALC_SYNC);
    expect(under(syncFiles.local, join(root, "data"))).toBe(false);
  });
});
