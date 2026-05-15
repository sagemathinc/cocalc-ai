import { transformArgs } from "./index";

describe("hub API argument transforms", () => {
  it("injects CLI auth_session_hash as session_hash for fresh-auth RPCs", async () => {
    const cases = [
      {
        name: "projects.moveProject",
        args: [{ project_id: "project-1", dest_host_id: "host-1" }],
      },
      {
        name: "hosts.deleteHost",
        args: [{ id: "host-1" }],
      },
      {
        name: "system.setAccountEntitlementOverride",
        args: [
          {
            user_account_id: "acct-2",
            override: { enabled: true },
            reason: "test",
          },
        ],
      },
      {
        name: "org.create",
        args: [{ name: "org-1" }],
      },
      {
        name: "purchases.purchaseMembershipPackage",
        args: [{ package_id: 1 }],
      },
    ];

    for (const testCase of cases) {
      const args = await transformArgs({
        name: testCase.name,
        args: structuredClone(testCase.args),
        account_id: "acct-1",
        auth_session_hash: "session-hash-1",
      });
      expect(args[0].account_id).toBe("acct-1");
      expect(args[0].session_hash).toBe("session-hash-1");
    }
  });

  it("does not overwrite an explicit session_hash", async () => {
    const args = await transformArgs({
      name: "projects.moveProject",
      args: [
        {
          project_id: "project-1",
          dest_host_id: "host-1",
          session_hash: "explicit-session-hash",
        },
      ],
      account_id: "acct-1",
      auth_session_hash: "cli-session-hash",
    });

    expect(args[0].session_hash).toBe("explicit-session-hash");
  });
});
