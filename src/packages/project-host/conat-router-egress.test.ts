/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { __test__ } from "./conat-router-egress";

describe("project-host conat router managed egress", () => {
  it("aggregates send-byte deltas by authenticated browser account", () => {
    expect(
      __test__.summarizeManagedConatEgressDeltas({
        previous: {
          socketA: {
            user: { account_id: "account-1" },
            browser_id: "browser-a",
            send: { messages: 1, bytes: 100 },
            recv: { messages: 1, bytes: 50 },
            subs: 1,
          },
        },
        current: {
          socketA: {
            user: { account_id: "account-1" },
            browser_id: "browser-a",
            send: { messages: 2, bytes: 250 },
            recv: { messages: 2, bytes: 75 },
            subs: 1,
          },
          socketB: {
            user: { account_id: "account-1" },
            browser_id: "browser-b",
            send: { messages: 1, bytes: 200 },
            recv: { messages: 0, bytes: 0 },
            subs: 1,
          },
          socketC: {
            user: { account_id: "account-2" },
            browser_id: "browser-c",
            send: { messages: 1, bytes: 80 },
            recv: { messages: 0, bytes: 0 },
            subs: 1,
          },
          socketD: {
            user: { hub_id: "system" },
            browser_id: "browser-d",
            send: { messages: 1, bytes: 999 },
            recv: { messages: 0, bytes: 0 },
            subs: 1,
          },
          socketE: {
            user: { account_id: "account-3" },
            send: { messages: 1, bytes: 999 },
            recv: { messages: 0, bytes: 0 },
            subs: 1,
          },
        },
      }),
    ).toEqual([
      {
        account_id: "account-1",
        bytes: 350,
        socket_ids: ["socketA", "socketB"],
        browser_ids: ["browser-a", "browser-b"],
      },
      {
        account_id: "account-2",
        bytes: 80,
        socket_ids: ["socketC"],
        browser_ids: ["browser-c"],
      },
    ]);
  });

  it("treats a counter reset as a fresh delta", () => {
    expect(
      __test__.summarizeManagedConatEgressDeltas({
        previous: {
          socketA: {
            user: { account_id: "account-1" },
            browser_id: "browser-a",
            send: { messages: 5, bytes: 500 },
            recv: { messages: 0, bytes: 0 },
            subs: 1,
          },
        },
        current: {
          socketA: {
            user: { account_id: "account-1" },
            browser_id: "browser-a",
            send: { messages: 1, bytes: 40 },
            recv: { messages: 0, bytes: 0 },
            subs: 1,
          },
        },
      }),
    ).toEqual([
      {
        account_id: "account-1",
        bytes: 40,
        socket_ids: ["socketA"],
        browser_ids: ["browser-a"],
      },
    ]);
  });

  it("formats the interactive session block message", () => {
    expect(
      __test__.buildBlockedMessage({
        managed_egress_5h_bytes: 373_000_000,
        managed_egress_7d_bytes: 500_000_000,
        egress_5h_bytes: 200_000_000,
        egress_7d_bytes: 1_000_000_000,
        managed_egress_categories_5h_bytes: {
          "interactive-conat": 373_000_000,
        },
      }),
    ).toContain("Interactive session traffic limit reached for this account.");
  });
});
