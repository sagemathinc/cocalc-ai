import {
  getHubApiAccountTargetMethods,
  getHubApiPrincipalPolicies,
  initHubApi,
  transformArgs,
} from "./index";
import { purchases } from "./purchases";

describe("hub API response handling", () => {
  it("returns failed LRO summaries instead of throwing their operation error", async () => {
    const summary = {
      op_id: "op-1",
      scope_type: "project",
      scope_id: "project-1",
      status: "failed",
      error: "copy failed",
    };
    const api = initHubApi(async () => summary);

    await expect(api.lro.get({ op_id: "op-1" })).resolves.toBe(summary);
  });

  it("still throws legacy RPC error envelopes for lro.get", async () => {
    const api = initHubApi(async () => ({ error: "not authorized" }));

    await expect(api.lro.get({ op_id: "op-1" })).rejects.toThrow(
      "not authorized",
    );
  });
});

describe("hub API argument transforms", () => {
  it("declares a principal policy for every Hub API method", () => {
    const policies = getHubApiPrincipalPolicies();
    expect(Object.keys(policies).length).toBeGreaterThan(700);
    expect(Object.values(policies)).not.toContain(undefined);
  });

  it("does not expose the retired anonymous project-app RPCs", () => {
    const policies = getHubApiPrincipalPolicies();
    for (const method of [
      "system.assertProjectPublicSharingAllowed",
      "system.getProjectAppPublicPolicy",
      "system.tracePublicAppHostname",
      "system.reserveProjectAppPublicSubdomain",
      "system.releaseProjectAppPublicSubdomain",
    ]) {
      expect(policies).not.toHaveProperty(method);
    }
  });

  it("requires review of every RPC that preserves account_id as target data", () => {
    expect(getHubApiAccountTargetMethods()).toEqual([
      "aiSessions.upsertProjectHostSession",
      "hosts.checkCodexSiteUsageAllowance",
      "hosts.getAccountEffectiveLimits",
      "hosts.issueProjectHostAgentAuthToken",
      "hosts.recordAcpAdmissionDenial",
      "hosts.recordCodexSiteUsage",
      "hosts.recordServiceAdmissionDenial",
      "hosts.recordServiceAdmissionNearLimit",
      "hosts.reserveSiteFundedCodexTurn",
      "hosts.touchProject",
      "notifications.createCodexAttentionNotice",
      "notifications.createCodexTurnNotice",
      "notifications.getCodexFreshAuthActionStatus",
      "notifications.startCodexFreshAuthAction",
      "projects.startFromHost",
      "publicDirectoryShares.authorizeRead",
      "publicDirectoryShares.getTemporaryViewerReadPolicy",
    ]);
  });

  it.each([
    "purchases.getMembership",
    "org.get",
    "sync.history",
    "system.manageApiKeys",
    "system.createImpersonationGrant",
    "system.setOpenAiApiKey",
    "system.upsertBrowserSession",
    "projects.previewEmailProjectInvite",
  ])("classifies %s as account-only", (name) => {
    expect(getHubApiPrincipalPolicies()[name]).toBe("account");
  });

  it("makes every account-only transform reject project and host principals", async () => {
    const accountOnlyMethods = Object.entries(getHubApiPrincipalPolicies())
      .filter(([, policy]) => policy === "account")
      .map(([name]) => name);

    for (const name of accountOnlyMethods) {
      await expect(
        Promise.resolve().then(() =>
          transformArgs({ name, args: [{}], project_id: "project-1" }),
        ),
      ).rejects.toThrow(/signed in|account/);
      await expect(
        Promise.resolve().then(() =>
          transformArgs({ name, args: [{}], host_id: "host-1" }),
        ),
      ).rejects.toThrow(/signed in|account/);
    }
  });

  it("binds every purchases RPC to the authenticated account principal", async () => {
    for (const functionName of Object.keys(purchases)) {
      const name = `purchases.${functionName}`;
      const accountArgs = await transformArgs({
        name,
        args: [
          {
            account_id: "victim-account",
            session_hash: "caller-session",
          },
        ],
        account_id: "caller-account",
      });
      expect(accountArgs[0].account_id).toBe("caller-account");

      await expect(
        transformArgs({
          name,
          args: [{ account_id: "victim-account" }],
          project_id: "caller-project",
        }),
      ).rejects.toThrow("user must be signed in");
      await expect(
        transformArgs({
          name,
          args: [{ account_id: "victim-account" }],
          host_id: "caller-host",
        }),
      ).rejects.toThrow("user must be signed in");
      await expect(
        transformArgs({
          name,
          args: [{ account_id: "victim-account" }],
          account_id: "agent-owner",
          project_id: "caller-project",
          auth_actor: "agent",
          auth_token_fingerprint: "a".repeat(64),
          auth_iat_s: 100,
          auth_exp_s: 1000,
        }),
      ).rejects.toThrow("user must be signed in");
    }
  });

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

  it("binds project VM SSH forwarding to the authenticated host", async () => {
    const args = await transformArgs({
      name: "compute.authorizeProjectSshKeyFromHost",
      args: [
        {
          host_id: "spoofed-host",
          project_id: "project-1",
          id_or_name: "compute-vm",
          ssh_public_key: "ssh-ed25519 AAAATEST project",
          idempotency_key: "authorize-1",
        },
      ],
      host_id: "host-1",
    });
    expect(args[0]).toMatchObject({
      host_id: "host-1",
      project_id: "project-1",
    });

    await expect(
      transformArgs({
        name: "compute.authorizeProjectSshKeyFromHost",
        args: [{ project_id: "project-1" }],
        project_id: "project-1",
      }),
    ).rejects.toThrow("must be a host");
  });

  it("drops account actor claims from generic project and host RPCs", async () => {
    const projectArgs = await transformArgs({
      name: "db.userQuery",
      args: [
        {
          account_id: "victim-account",
          project_id: "spoofed-project",
          query: { projects: [{ project_id: null }] },
        },
      ],
      project_id: "caller-project",
    });
    expect(projectArgs[0]).toMatchObject({ project_id: "caller-project" });
    expect(projectArgs[0]).not.toHaveProperty("account_id");

    const hostArgs = await transformArgs({
      name: "system.getProjectAppPrivateHostnamePolicy",
      args: [
        {
          account_id: "victim-account",
          project_id: "target-project",
        },
      ],
      host_id: "caller-host",
    });
    expect(hostArgs[0]).toMatchObject({
      host_id: "caller-host",
      project_id: "target-project",
    });
    expect(hostArgs[0]).not.toHaveProperty("account_id");
  });

  it("preserves explicitly declared account targets for host RPCs", async () => {
    const viewerArgs = await transformArgs({
      name: "publicDirectoryShares.authorizeRead",
      args: [
        {
          account_id: "viewer-account",
          project_id: "project-1",
          share_id: "share-1",
        },
      ],
      host_id: "caller-host",
    });
    expect(viewerArgs[0]).toMatchObject({
      account_id: "viewer-account",
      host_id: "caller-host",
      project_id: "project-1",
    });

    const sessionArgs = await transformArgs({
      name: "aiSessions.upsertProjectHostSession",
      args: [
        {
          account_id: "session-account",
          project_id: "project-1",
          state: "running",
        },
      ],
      host_id: "caller-host",
    });
    expect(sessionArgs[0]).toMatchObject({
      account_id: "session-account",
      authenticated_host_id: "caller-host",
      project_id: "project-1",
    });
    await expect(
      transformArgs({
        name: "aiSessions.upsertProjectHostSession",
        args: [{ account_id: "victim-account", project_id: "project-1" }],
        project_id: "project-1",
      }),
    ).rejects.toThrow("requires host authentication");
  });

  it("authorizes project VM reads for collaborators without trusting spoofed principals", async () => {
    const accountArgs = await transformArgs({
      name: "compute.listProjectVms",
      args: [
        {
          account_id: "spoofed-account",
          project_id: "project-1",
          host_id: "spoofed-host",
        },
      ],
      account_id: "account-1",
    });
    expect(accountArgs[0]).toMatchObject({
      account_id: "account-1",
      project_id: "project-1",
    });
    expect(accountArgs[0].host_id).toBeUndefined();

    const projectArgs = await transformArgs({
      name: "compute.listProjectVms",
      args: [
        {
          account_id: "spoofed-account",
          project_id: "spoofed-project",
        },
      ],
      project_id: "project-1",
    });
    expect(projectArgs[0]).toEqual({ project_id: "project-1" });

    const hostArgs = await transformArgs({
      name: "compute.listProjectVms",
      args: [
        {
          account_id: "spoofed-account",
          project_id: "project-1",
          host_id: "spoofed-host",
        },
      ],
      host_id: "host-1",
    });
    expect(hostArgs[0]).toEqual({
      project_id: "project-1",
      host_id: "host-1",
    });

    const agentArgs = await transformArgs({
      name: "compute.listProjectVms",
      args: [
        {
          account_id: "spoofed-account",
          project_id: "spoofed-project",
          host_id: "spoofed-host",
        },
      ],
      account_id: "agent-owner",
      project_id: "project-1",
      auth_actor: "agent",
      auth_token_fingerprint: "a".repeat(64),
      auth_iat_s: 100,
      auth_exp_s: 1000,
    });
    expect(agentArgs[0]).toEqual({
      project_id: "project-1",
      agent_auth: {
        account_id: "agent-owner",
        project_id: "project-1",
        token_fingerprint: "a".repeat(64),
        issued_at_s: 100,
        expires_at_s: 1000,
      },
    });

    await expect(
      transformArgs({
        name: "compute.listProjectVms",
        args: [{}],
        account_id: "account-1",
      }),
    ).rejects.toThrow("project_id is required");
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
      expect(hostArgs[0].account_id).toBeUndefined();

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

  it("registers private app hostname RPCs and injects caller identities", async () => {
    const rpcNames = [
      "system.getProjectAppPrivateHostnamePolicy",
      "system.inspectProjectAppPrivateHostname",
      "system.listProjectAppPrivateHostnames",
      "system.tracePrivateAppHostname",
      "system.reserveProjectAppPrivateHostname",
      "system.releaseProjectAppPrivateHostname",
      "system.reconcileProjectAppPrivateHostnames",
    ];

    for (const name of rpcNames) {
      const args = await transformArgs({
        name,
        args: [{ project_id: "project-1", app_id: "app-1" }],
        account_id: "account-1",
      });
      expect(args[0].account_id).toBe("account-1");
    }

    for (const name of [
      "system.getProjectAppPrivateHostnamePolicy",
      "system.inspectProjectAppPrivateHostname",
      "system.listProjectAppPrivateHostnames",
      "system.reserveProjectAppPrivateHostname",
      "system.releaseProjectAppPrivateHostname",
    ]) {
      await expect(
        transformArgs({
          name,
          args: [{ project_id: "spoofed-project", app_id: "app-1" }],
          project_id: "project-1",
        }),
      ).resolves.toEqual([{ project_id: "project-1", app_id: "app-1" }]);
    }

    await expect(
      transformArgs({
        name: "system.tracePrivateAppHostname",
        args: [{ host_id: "spoofed-host", hostname: "dev-1.example.com" }],
        host_id: "host-1",
      }),
    ).resolves.toEqual([{ host_id: "host-1", hostname: "dev-1.example.com" }]);
  });
});
