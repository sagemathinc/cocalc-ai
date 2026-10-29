/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { changedBeyondRuntimeFiles } from "./project-runtime-changes";

describe("changedBeyondRuntimeFiles", () => {
  const changed = (paths: string[], truncated = false) =>
    changedBeyondRuntimeFiles({ paths, truncated });

  it("ignores only the runtime's log and pid file, and their directory", () => {
    expect(changed([])).toBe(false);
    expect(
      changed([
        ".cache/cocalc/project",
        ".cache/cocalc/project/log",
        ".cache/cocalc/project/project.pid",
      ]),
    ).toBe(false);
  });

  it("counts everything else, hidden or not", () => {
    expect(changed(["."])).toBe(true);
    expect(changed([".bash_history"])).toBe(true);
    expect(changed([".local/share/cocalc/persist/project-log.db"])).toBe(true);
    expect(changed([".cache/cocalc/project/other"])).toBe(true);
    expect(changed([".cache/cocalc/project/log", "notes.md"])).toBe(true);
    // the directory alone: something else in it changed
    expect(changed([".cache/cocalc/project"])).toBe(true);
  });

  it("counts a truncated scan as changed", () => {
    expect(changed([".cache/cocalc/project/log"], true)).toBe(true);
  });
});
