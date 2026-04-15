/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { rolloutComponentsForUpgradeResults } from "./hosts";

describe("rolloutComponentsForUpgradeResults", () => {
  it("maps updated project-host artifacts to a managed project-host rollout", () => {
    expect(
      rolloutComponentsForUpgradeResults([
        { artifact: "tools", version: "tools-1", status: "updated" },
        {
          artifact: "project-host",
          version: "project-host-2",
          status: "updated",
        },
      ]),
    ).toEqual(["project-host"]);
  });

  it("ignores noop project-host upgrades and non-project-host artifacts", () => {
    expect(
      rolloutComponentsForUpgradeResults([
        { artifact: "project", version: "project-1", status: "updated" },
        {
          artifact: "project-host",
          version: "project-host-1",
          status: "noop",
        },
      ]),
    ).toEqual([]);
  });
});
