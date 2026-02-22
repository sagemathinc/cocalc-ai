/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  normalizeState,
  parsePsLine,
} from "./owned-darwin-snapshot-provider";

describe("owned darwin snapshot helpers", () => {
  it("parses ps output lines", () => {
    const row = parsePsLine(
      "123 45 10.5 20480 360 -5 R /usr/bin/python3 /usr/bin/python3 script.py --flag",
    );
    expect(row).toEqual({
      pid: 123,
      ppid: 45,
      cpuPct: 10.5,
      rssMiB: 20,
      etimes: 360,
      nice: -5,
      state: "R",
      comm: "/usr/bin/python3",
      args: "/usr/bin/python3 script.py --flag",
    });
  });

  it("normalizes mac state codes", () => {
    expect(normalizeState("R")).toBe("R");
    expect(normalizeState("U")).toBe("S");
    expect(normalizeState("TS")).toBe("T");
    expect(normalizeState("DZ")).toBe("D");
  });
});

