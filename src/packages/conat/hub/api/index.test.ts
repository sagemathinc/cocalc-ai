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
      {
        name: "system.issueBrowserSignInCookie",
        args: [{ max_age_ms: 60_000 }],
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

  it("forces browser sign-in cookie issuance to the authenticated account", async () => {
    const args = await transformArgs({
      name: "system.issueBrowserSignInCookie",
      args: [{ account_id: "victim-account", max_age_ms: 60_000 }],
      account_id: "caller-account",
    });

    expect(args).toEqual([
      { account_id: "caller-account", max_age_ms: 60_000 },
    ]);
  });

  it("rejects project-authenticated browser sign-in cookie issuance", async () => {
    await expect(
      transformArgs({
        name: "system.issueBrowserSignInCookie",
        args: [{ account_id: "victim-account" }],
        project_id: "project-1",
      }),
    ).rejects.toThrow("user must be signed in");
  });

  it("rejects host-authenticated browser sign-in cookie issuance", async () => {
    await expect(
      transformArgs({
        name: "system.issueBrowserSignInCookie",
        args: [{ account_id: "victim-account" }],
        host_id: "host-1",
      }),
    ).rejects.toThrow("user must be signed in");
  });

  it("allows host-authenticated project starts only through startFromHost", async () => {
    const args = await transformArgs({
      name: "projects.startFromHost",
      args: [
        {
          account_id: "acct-1",
          project_id: "project-1",
          host_id: "spoofed-host",
        },
      ],
      host_id: "host-1",
    });

    expect(args).toEqual([
      {
        account_id: "acct-1",
        project_id: "project-1",
        host_id: "host-1",
      },
    ]);

    await expect(
      transformArgs({
        name: "projects.start",
        args: [{ account_id: "acct-1", project_id: "project-1" }],
        host_id: "host-1",
      }),
    ).rejects.toThrow("user must be signed in");
  });

  it("restricts managed metering RPCs to project or host principals", async () => {
    const rpcNames = [
      "system.recordManagedProjectEgress",
      "system.getManagedProjectEgressPolicy",
      "system.recordManagedProjectCpuUsage",
    ];

    for (const name of rpcNames) {
      const hostArgs = await transformArgs({
        name,
        args: [
          {
            project_id: "spoofed-project",
            host_id: "spoofed-host",
            account_id: "account-for-download-attribution",
            category: "file-download",
            bytes: 1,
            cpu_seconds: 1,
          },
        ],
        host_id: "host-1",
      });
      expect(hostArgs[0].host_id).toBe("host-1");
      expect(hostArgs[0].project_id).toBe("spoofed-project");
      expect(hostArgs[0].account_id).toBe("account-for-download-attribution");

      const projectArgs = await transformArgs({
        name,
        args: [
          {
            project_id: "spoofed-project",
            host_id: "spoofed-host",
            account_id: "spoofed-account",
            category: "file-download",
            bytes: 1,
            cpu_seconds: 1,
          },
        ],
        project_id: "project-1",
      });
      expect(projectArgs[0].project_id).toBe("project-1");
      expect(projectArgs[0].host_id).toBeUndefined();
      expect(projectArgs[0].account_id).toBeUndefined();

      await expect(
        transformArgs({
          name,
          args: [
            {
              project_id: "spoofed-project",
              host_id: "spoofed-host",
              category: "file-download",
              bytes: 1,
              cpu_seconds: 1,
            },
          ],
          account_id: "acct-1",
        }),
      ).rejects.toThrow("must be a project or host");
    }
  });

  it("requires account auth for name and local UI helpers without reshaping args", async () => {
    const cases = [
      {
        name: "system.getNames",
        args: [["account-1"]],
      },
      {
        name: "ssh.listSessionsUI",
        args: [{ withStatus: true }],
      },
      {
        name: "reflect.listSessionsUI",
        args: [{ selectors: ["active"] }],
      },
    ];

    for (const testCase of cases) {
      const accountArgs = await transformArgs({
        name: testCase.name,
        args: structuredClone(testCase.args),
        account_id: "caller-account",
      });
      expect(accountArgs).toEqual(testCase.args);

      await expect(async () =>
        transformArgs({
          name: testCase.name,
          args: structuredClone(testCase.args),
          project_id: "project-1",
        }),
      ).rejects.toThrow("user must be signed in with an account");

      await expect(async () =>
        transformArgs({
          name: testCase.name,
          args: structuredClone(testCase.args),
          host_id: "host-1",
        }),
      ).rejects.toThrow("user must be signed in with an account");
    }
  });
});
