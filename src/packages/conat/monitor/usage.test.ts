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

  it("counts API-key sockets with distinct reply inboxes against one account limit", () => {
    const usage = new UsageMonitor({
      resource: "connections to CoCalc",
      maxPerUser: 1,
    });
    const first = {
      account_id: "11111111-1111-4111-8111-111111111111",
      auth_method: "api_key",
      auth_api_key_reply_prefix:
        "_INBOX.api-key-22222222-2222-4222-8222-222222222222",
    };
    const second = {
      ...first,
      auth_api_key_reply_prefix:
        "_INBOX.api-key-33333333-3333-4333-8333-333333333333",
    };
    usage.add(first);
    expect(() => usage.add(second)).toThrow(
      "There is a per user limit of 1 connections to CoCalc.",
    );
    expect(usage.stats()).toMatchObject({ total: 1 });
    expect(Object.values(usage.stats().perUser)).toEqual([1]);
    usage.delete(first);
    usage.add(second);
    expect(usage.stats()).toMatchObject({ total: 1 });
  });

  it("does not split an account bucket on other session metadata", () => {
    const usage = new UsageMonitor({ resource: "connections", maxPerUser: 1 });
    usage.add({ account_id: "account-1", auth_session_hash: "session-1" });
    expect(() =>
      usage.add({ account_id: "account-1", auth_session_hash: "session-2" }),
    ).toThrow("There is a per user limit of 1 connections.");
  });
});
