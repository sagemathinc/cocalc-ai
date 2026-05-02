import { __test__ } from "./managed-egress";

describe("hub conat managed egress", () => {
  it("aggregates outbound-byte deltas only for browser-facing account sockets", () => {
    expect(
      __test__.summarizeManagedConatEgressDeltas({
        previous: {
          socketA: {
            user: { account_id: "account-1" },
            browser_id: "browser-a",
            recv: { messages: 1, bytes: 100 },
            egress: { messages: 1, bytes: 1000 },
            subs: 1,
          },
        },
        current: {
          socketA: {
            user: { account_id: "account-1" },
            browser_id: "browser-a",
            recv: { messages: 2, bytes: 250 },
            egress: { messages: 2, bytes: 1250 },
            subs: 1,
          },
          socketB: {
            user: { account_id: "account-1" },
            browser_id: "browser-b",
            recv: { messages: 1, bytes: 55 },
            egress: { messages: 1, bytes: 55 },
            subs: 1,
          },
          socketC: {
            user: { account_id: "account-1" },
            recv: { messages: 1, bytes: 999 },
            egress: { messages: 1, bytes: 999 },
            subs: 1,
          },
          socketD: {
            user: { project_id: "project-1" },
            browser_id: "browser-d",
            recv: { messages: 1, bytes: 999 },
            egress: { messages: 1, bytes: 999 },
            subs: 1,
          },
          socketE: {
            user: { hub_id: "system" },
            browser_id: "browser-e",
            recv: { messages: 1, bytes: 999 },
            egress: { messages: 1, bytes: 999 },
            subs: 1,
          },
        },
      }),
    ).toEqual([
      {
        account_id: "account-1",
        bytes: 205,
        socket_ids: ["socketA", "socketB"],
        browser_ids: ["browser-a", "browser-b"],
      },
    ]);
  });

  it("ignores protocol chatter when no additional client recv bytes arrive", () => {
    expect(
      __test__.summarizeManagedConatEgressDeltas({
        previous: {
          socketA: {
            user: { account_id: "account-1" },
            browser_id: "browser-a",
            recv: { messages: 10, bytes: 1024 },
            egress: { messages: 10, bytes: 4096 },
            subs: 1,
          },
        },
        current: {
          socketA: {
            user: { account_id: "account-1" },
            browser_id: "browser-a",
            recv: { messages: 10, bytes: 1024 },
            egress: { messages: 15, bytes: 12288 },
            subs: 1,
          },
        },
      }),
    ).toEqual([]);
  });

  it("formats the hub interactive session block message", () => {
    expect(
      __test__.buildBlockedMessage({
        account_id: "account-1",
        category: "interactive-conat",
        allowed: false,
        blocked_by: "5h",
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
