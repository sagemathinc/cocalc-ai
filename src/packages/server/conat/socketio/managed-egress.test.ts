import { parseManagedEgressBlockedMessage } from "@cocalc/util/managed-egress-message";
import { __test__ } from "./managed-egress";

describe("hub conat managed egress", () => {
  it("aggregates outbound-byte deltas only for browser-facing account sockets", () => {
    expect(
      __test__.summarizeManagedConatEgressDeltas({
        previous: {
          socketA: {
            user: { account_id: "account-1" },
            browser_id: "browser-a",
            egress: { messages: 1, bytes: 1000 },
            subs: 1,
          },
        },
        current: {
          socketA: {
            user: { account_id: "account-1" },
            browser_id: "browser-a",
            egress: { messages: 2, bytes: 1250 },
            subs: 1,
          },
          socketB: {
            user: { account_id: "account-1" },
            browser_id: "browser-b",
            egress: { messages: 1, bytes: 55 },
            subs: 1,
          },
          socketC: {
            user: { account_id: "account-1" },
            egress: { messages: 1, bytes: 999 },
            subs: 1,
          },
          socketD: {
            user: { project_id: "project-1" },
            browser_id: "browser-d",
            egress: { messages: 1, bytes: 999 },
            subs: 1,
          },
          socketE: {
            user: { hub_id: "system" },
            browser_id: "browser-e",
            egress: { messages: 1, bytes: 999 },
            subs: 1,
          },
        },
      }),
    ).toEqual([
      {
        account_id: "account-1",
        bytes: 305,
        socket_ids: ["socketA", "socketB"],
        browser_ids: ["browser-a", "browser-b"],
        by_subject: {},
      },
    ]);
  });

  it("attributes each account's egress delta to subjects across sockets", () => {
    const [delta] = __test__.summarizeManagedConatEgressDeltas({
      previous: {
        socketA: {
          user: { account_id: "account-1" },
          browser_id: "browser-a",
          egress: { messages: 1, bytes: 100 },
          egress_by_subject: { "reply:persist.*.history": 100 },
          subs: 1,
        },
      },
      current: {
        socketA: {
          user: { account_id: "account-1" },
          browser_id: "browser-a",
          egress: { messages: 3, bytes: 900 },
          egress_by_subject: {
            "reply:persist.*.history": 700,
            "(control)": 200,
          },
          subs: 1,
        },
        socketB: {
          user: { account_id: "account-1" },
          browser_id: "browser-b",
          egress: { messages: 1, bytes: 50 },
          egress_by_subject: { "reply:persist.*.history": 50 },
          subs: 1,
        },
      },
    });
    expect(delta.by_subject).toEqual({
      "reply:persist.*.history": 650,
      "(control)": 200,
    });
  });

  it("formats the independent control-plane safety block message", () => {
    expect(
      __test__.buildBlockedMessage({
        account_id: "account-1",
        category: "control-plane-conat",
        allowed: false,
        blocked_by: "7d",
        managed_egress_5h_bytes: 11_000_000_000,
        managed_egress_7d_bytes: 5_000_000_000,
        egress_5h_bytes: 10_000_000_000,
        egress_7d_bytes: 100_000_000_000,
        managed_egress_categories_5h_bytes: {
          "control-plane-conat": 11_000_000_000,
        },
        managed_egress_categories_7d_bytes: {
          "control-plane-conat": 5_000_000_000,
        },
      }),
    ).toContain(
      "7-day network usage by category: Account control traffic: 5 GB.",
    );
  });

  it("gives browsers a specific, machine-recognizable block message, never a generic sign-in error", () => {
    const blocked_until = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const message = __test__.buildBlockedMessage({
      account_id: "account-1",
      category: "control-plane-conat",
      allowed: false,
      blocked_by: "7d",
      blocked_until,
      managed_egress_5h_bytes: 1_000_000_000,
      managed_egress_7d_bytes: 108_000_000_000,
      egress_5h_bytes: 10_000_000_000,
      egress_7d_bytes: 100_000_000_000,
    });
    expect(message).not.toMatch(/you must sign in/i);
    expect(message).toContain("cocalc CLI) still works");
    expect(message).toMatch(/contact support/i);
    expect(parseManagedEgressBlockedMessage(message)).toMatchObject({
      category: "control-plane-conat",
      window: "7d",
      resets_at: blocked_until.toISOString(),
    });
  });
});
