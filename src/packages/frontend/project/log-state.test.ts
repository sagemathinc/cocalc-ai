/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  buildProjectLogMap,
  mergeProjectLogMap,
  newestProjectLogCursor,
  oldestProjectLogCursor,
} from "./log-state";

describe("project log helpers", () => {
  it("builds cursors and merges rows by id", () => {
    const initial = buildProjectLogMap([
      {
        id: "row-2",
        project_id: "project-1",
        account_id: "acct-1",
        time: new Date("2026-04-05T05:00:00.000Z"),
        event: { event: "set", title: "middle" },
      },
      {
        id: "row-1",
        project_id: "project-1",
        account_id: "acct-1",
        time: new Date("2026-04-05T06:00:00.000Z"),
        event: { event: "set", title: "newest" },
      },
      {
        id: "row-3",
        project_id: "project-1",
        account_id: "acct-1",
        time: new Date("2026-04-05T04:00:00.000Z"),
        event: { event: "set", title: "oldest" },
      },
    ]);

    expect(newestProjectLogCursor(initial)).toEqual({
      id: "row-1",
      time: new Date("2026-04-05T06:00:00.000Z"),
    });
    expect(oldestProjectLogCursor(initial)).toEqual({
      id: "row-3",
      time: new Date("2026-04-05T04:00:00.000Z"),
    });

    const merged = mergeProjectLogMap(initial, [
      {
        id: "row-4",
        project_id: "project-1",
        account_id: "acct-1",
        time: new Date("2026-04-05T06:30:00.000Z"),
        event: { event: "set", title: "newest-again" },
      },
      {
        id: "row-2",
        project_id: "project-1",
        account_id: "acct-1",
        time: new Date("2026-04-05T05:00:00.000Z"),
        event: { event: "set", title: "updated-middle" },
      },
    ]);

    expect(merged.size).toBe(4);
    expect(merged.getIn(["row-2", "event", "title"])).toBe("updated-middle");
    expect(newestProjectLogCursor(merged)).toEqual({
      id: "row-4",
      time: new Date("2026-04-05T06:30:00.000Z"),
    });
  });
});
