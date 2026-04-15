/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { UsageMonitor } from "./usage";

describe("UsageMonitor", () => {
  it("emits the denied user identity for per-user limits", () => {
    const usage = new UsageMonitor({
      resource: "connections to CoCalc",
      maxPerUser: 1,
    });
    const deny = jest.fn();
    usage.on("deny", deny);

    const user = { hub_id: "hub" };
    usage.add(user);
    expect(() => usage.add(user)).toThrow(
      "There is a per user limit of 1 connections to CoCalc.",
    );

    expect(deny).toHaveBeenCalledWith(user, 1, "per-user");
  });

  it("supports dynamic per-user limits", () => {
    const usage = new UsageMonitor({
      resource: "connections to CoCalc",
      maxPerUser: 1,
      getMaxPerUser: (user) =>
        (user as { hub_id?: string }).hub_id === "hub" ? 3 : undefined,
    });

    const hubUser = { hub_id: "hub" };
    usage.add(hubUser);
    usage.add(hubUser);
    usage.add(hubUser);

    expect(() => usage.add(hubUser)).toThrow(
      "There is a per user limit of 3 connections to CoCalc.",
    );
  });
});
