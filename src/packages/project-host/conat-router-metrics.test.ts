/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { __test__ } from "./conat-router-metrics";

describe("project-host conat router metrics", () => {
  it("summarizes traffic rates and reconnect bursts from successive snapshots", () => {
    const summary = __test__.summarizeConatRouterTraffic({
      intervalMs: 10_000,
      previous: {
        a: {
          send: { messages: 10, bytes: 1_000 },
          recv: { messages: 5, bytes: 200 },
          subs: 1,
          connected: 1,
          address: "203.0.113.10",
          browser_id: "browser-a",
          user: { account_id: "account-a" },
        },
        b: {
          send: { messages: 4, bytes: 50 },
          recv: { messages: 8, bytes: 400 },
          subs: 2,
          connected: 1,
          address: "198.51.100.8",
          browser_id: "browser-b",
          user: { hub_id: "hub" },
        },
      },
      current: {
        a: {
          send: { messages: 14, bytes: 1_300 },
          recv: { messages: 8, bytes: 240 },
          subs: 1,
          connected: 1,
          address: "203.0.113.10",
          browser_id: "browser-a",
          user: { account_id: "account-a" },
        },
        c: {
          send: { messages: 1, bytes: 90 },
          recv: { messages: 4, bytes: 120 },
          subs: 3,
          connected: 2,
          address: "203.0.113.10",
          browser_id: "browser-c",
          user: { error: "denied" },
        },
        d: {
          send: { messages: 0, bytes: 0 },
          recv: { messages: 0, bytes: 0 },
          subs: 1,
          connected: 3,
          address: "203.0.113.10",
          browser_id: "browser-c",
          user: { project_id: "project-a" },
        },
      },
    });

    expect(summary).toEqual({
      interval_ms: 10_000,
      active_connections: 3,
      opened_connections: 2,
      closed_connections: 1,
      unique_addresses: 1,
      unique_browsers: 2,
      unique_accounts: 1,
      unique_projects: 1,
      unique_hubs: 0,
      auth_error_connections: 1,
      subscriptions: 5,
      recv_messages: 7,
      send_messages: 5,
      recv_bytes: 160,
      send_bytes: 390,
      recv_messages_per_s: 0.7,
      send_messages_per_s: 0.5,
      recv_bytes_per_s: 16,
      send_bytes_per_s: 39,
      top_opened_browsers: [{ browser_id: "browser-c", connections: 2 }],
      top_opened_addresses: [{ address: "203.0.113.10", connections: 2 }],
    });
  });

  it("treats counter resets as fresh traffic instead of negative rates", () => {
    expect(__test__.diffCounter(3, 10)).toBe(3);
    expect(__test__.roundRate(25, 5_000)).toBe(5);
  });
});
