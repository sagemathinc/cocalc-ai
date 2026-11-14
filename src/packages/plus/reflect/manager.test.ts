/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createSessionLogWriter } from "./manager";

describe("reflect session log writer", () => {
  it("drops an entry it cannot write instead of throwing", () => {
    const rows: unknown[][] = [];
    let sessionExists = true;
    const db = {
      prepare: () => ({
        run: (...row: unknown[]) => {
          if (!sessionExists) {
            throw new Error("FOREIGN KEY constraint failed");
          }
          rows.push(row);
        },
      }),
      close: () => {},
    };
    const writer = createSessionLogWriter(
      { openSessionDb: () => db } as any,
      "/unused/sessions.db",
      7,
    );
    writer!.log("info", "scheduler started");
    // the session is terminated before its scheduler's exit is logged
    sessionExists = false;
    expect(() =>
      writer!.log("warn", "scheduler exited", { code: 0 }),
    ).not.toThrow();
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe(7);
  });
});
