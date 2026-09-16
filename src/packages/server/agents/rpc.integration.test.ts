import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, createHash } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { agentStore } from "./store";
import {
  agentRpcControl,
  grantRpcLink,
  revokeRpcLink,
  acceptAgentRpc,
  acceptExternalAgentRpc,
  authorizeRpcAdmission,
  authorizeRpcExecution,
} from "./rpc";
import { agentMessagingSubject } from "@cocalc/conat/agents/protocol";
import { rpcOutcome } from "@cocalc/conat/agents/rpc";
import { getIdentityLocal } from "./api";
import {
  grantPersonalConnection,
  nameAgent,
  listNamedAgents,
  listPersonalConnections,
  setPersonalMessagingState,
  setPersonalConnectionState,
  resolvePersonalConnectionRequest,
} from "./personal";
import { externalStore } from "./external";
import { externalAgentSubject } from "@cocalc/conat/agents/external";

const context = new AsyncLocalStorage<string>();
const owners = new Map<string, string>();
const fresh = jest.fn();
const collab = jest.fn();
const admitted = jest.fn();
const beforeAdmission = jest.fn();
const inspected = jest.fn();
const homeFence = jest.fn();
let offlineBay: string | undefined;
const routedCalls: any[] = [];
let hostId: string;
let wireClient: import("@cocalc/conat/core/client").Client | undefined;
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => context.getStore() ?? "home",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({ home_bay_id: "home" }),
}));
jest.mock("@cocalc/server/agents/personal-rehome", () => ({
  assertPersonalAccountAuthority: (...args) => homeFence(...args),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: async (project) => ({
    bay_id: owners.get(project),
    epoch: 1,
  }),
  resolveHostBayAcrossCluster: async () => ({
    bay_id: context.getStore(),
    epoch: 1,
  }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/agent-rpc", () => ({
  createAgentRpcControlClient: (_client, bay) => {
    if (wireClient)
      return jest
        .requireActual("@cocalc/conat/inter-bay/agent-rpc")
        .createAgentRpcControlClient(wireClient, bay);
    return new Proxy(
      {},
      {
        get: (_obj, method) => async (opts) => {
          routedCalls.push({ bay, method, opts });
          if (bay === offlineBay) throw new Error("bay offline");
          return context.run(bay, () => agentRpcControl[method](opts));
        },
      },
    );
  },
}));
jest.mock("@cocalc/conat/inter-bay/agent-identities", () => ({
  createInterBayAgentIdentityClient: ({ bay_id: bay }) => ({
    get: (opts) => context.run(bay, () => getIdentityLocal(opts)),
  }),
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (opts) => fresh(opts),
}));
jest.mock("@cocalc/server/conat/api/util", () => ({
  assertCollab: (opts) => collab(opts),
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: async () => {},
  isAccountBannedCached: () => false,
  getAccountRevokedBeforeCached: () => undefined,
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertProjectHostAgentTokenAccess: async (opts) => {
    if (opts.host_id !== hostId) throw new Error("wrong host");
  },
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  getExplicitHostControlClient: async () => ({}),
}));
jest.mock("@cocalc/conat/project-host/api", () => ({
  createHostControlClient: (opts) => ({
    prepareAgentRpcAttachments: async (e) => {
      expect(opts.noRetry).toBe(true);
      await authorizeRpcAdmission({
        account_id: e.account_id,
        host_id: hostId,
        envelope: e,
      });
      return {
        version: 2,
        target: e.target,
        attempt_id: e.attempt_id,
        outcome: "prepared",
        reservation_id: randomUUID(),
        expires_at: e.deadline,
      };
    },
    cancelAgentRpcAttachments: async (e) => {
      await authorizeRpcAdmission({
        account_id: e.account_id,
        host_id: hostId,
        envelope: e,
      });
    },
    submitAgentRpc: async (...args) => {
      const [e, files] = args;
      // An explicit undefined second argument becomes null on the wire.
      // Require its absence for text and same-project reference sends.
      if (!e.snapshot_manifest && args.length !== 1)
        throw new Error("unexpected attachment payload");
      expect(opts.noRetry).toBe(true);
      await beforeAdmission(e);
      await authorizeRpcAdmission({
        account_id: e.account_id,
        host_id: hostId,
        envelope: e,
      });
      await admitted(e, files);
      return rpcOutcome(e, "accepted");
    },
    inspectAgentRpc: async (opts) => {
      await inspected(opts);
      return rpcOutcome(opts.request, "unknown");
    },
  }),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("RPC owner routing and authorization with PostgreSQL grants", () => {
  const account = randomUUID(),
    other = randomUUID(),
    sourceProject = randomUUID(),
    targetProject = randomUUID();
  const source = { project_id: sourceProject, agent_id: randomUUID() };
  const target = { project_id: targetProject, agent_id: randomUUID() };
  const run = randomUUID();
  beforeAll(async () => {
    process.env.COCALC_AGENT_MESSAGING_ENABLED = "1";
    process.env.COCALC_AGENT_MESSAGING_RPC_ENABLED = "1";
    hostId = randomUUID();
    owners.set(sourceProject, "source-bay");
    owners.set(targetProject, "target-bay");
    const db = getPool();
    await db.query(
      "CREATE TABLE IF NOT EXISTS projects(project_id uuid PRIMARY KEY, host_id uuid, state jsonb, deleted boolean)",
    );
    await syncSchema(
      Object.fromEntries(
        [
          "agent_identities",
          "agent_identity_runs",
          "agent_rpc_links",
          "agent_rpc_admission_state",
          "agent_personal_names",
          "agent_personal_grants",
          "agent_personal_controls",
          "agent_personal_requests",
          "agent_external_identities",
          "agent_external_installations",
        ].map((name) => [name, SCHEMA[name]]),
      ),
    );
    for (const endpoint of [source, target]) {
      await db.query(
        'INSERT INTO projects(project_id,host_id,state) VALUES($1,$2,\'{"state":"running"}\')',
        [endpoint.project_id, hostId],
      );
      await db.query(
        `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by)
        VALUES($1,$2,'/home/user/test.chat',$3,'test',$4)`,
        [endpoint.agent_id, endpoint.project_id, randomUUID(), account],
      );
      await db.query(
        `INSERT INTO agent_identity_runs(agent_id,run_id,account_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '1 hour')`,
        [endpoint.agent_id, run, account, randomUUID()],
      );
    }
  });
  beforeEach(async () => {
    wireClient = undefined;
    delete process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED;
    delete process.env.COCALC_AGENT_MESSAGING_ATTACHMENTS_ENABLED;
    delete process.env.COCALC_AGENT_EXTERNAL_LOGIN_ENABLED;
    offlineBay = undefined;
    fresh.mockReset().mockResolvedValue(undefined);
    collab.mockReset().mockResolvedValue(undefined);
    admitted.mockReset().mockResolvedValue(undefined);
    beforeAdmission.mockReset().mockResolvedValue(undefined);
    inspected.mockReset().mockResolvedValue(undefined);
    homeFence.mockReset().mockResolvedValue(undefined);
    routedCalls.length = 0;
    await agentStore().query("DELETE FROM agent_rpc_links");
    for (const table of [
      "agent_personal_names",
      "agent_personal_grants",
      "agent_personal_controls",
      "agent_personal_requests",
      "agent_external_installations",
      "agent_external_identities",
    ])
      await agentStore().query(`DELETE FROM ${table}`);
  });
  const approve = (from = source, to = target) =>
    grantRpcLink({
      account_id: account,
      session_hash: "human-home-session",
      source: from,
      target: to,
      link_id: randomUUID(),
      reason: "review",
      ttl_seconds: 3600,
    });
  const send = (from = source, to = target) =>
    context.run(owners.get(from.project_id)!, () =>
      acceptAgentRpc(agentMessagingSubject(from.agent_id, run), {
        version: 2,
        action: "send",
        attempt_id: randomUUID(),
        target: to,
        body: "request-or-correlated-reply",
      }),
    );

  test("external home-approved source sends across owners, with no native run; revocation after startup rejects", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    process.env.COCALC_AGENT_EXTERNAL_LOGIN_ENABLED = "1";
    const installation = await externalStore().enroll(
      account,
      "fresh-human-home",
      {
        installation_id: randomUUID(),
        label: "SOC-2 QA",
        secret_hash: "a".repeat(64),
        targets: [target],
        ttl_seconds: 3600,
      },
    );
    const subject = externalAgentSubject(account, installation.installation_id);
    const request = {
      version: 2 as const,
      action: "send" as const,
      attempt_id: randomUUID(),
      target,
      body: "external evidence",
    };
    expect(await acceptExternalAgentRpc(subject, request)).toMatchObject({
      outcome: "accepted",
    });
    const envelope = admitted.mock.calls[0][0];
    expect(envelope.source).toEqual({
      kind: "external",
      account_id: account,
      agent_id: installation.agent_id,
      installation_id: installation.installation_id,
    });
    expect(envelope).not.toHaveProperty("run_id");
    expect(envelope.account_id).toBe(account);
    expect(
      routedCalls.some(
        (c) =>
          c.bay === "home" &&
          c.method === "external" &&
          c.opts.action === "check-send",
      ),
    ).toBe(true);
    beforeAdmission.mockImplementationOnce(async () =>
      context.run("home", () =>
        externalStore().revoke(account, installation.installation_id),
      ),
    );
    const next = await acceptExternalAgentRpc(subject, {
      ...request,
      attempt_id: randomUUID(),
    });
    // This host stub throws rather than returning the receiver's rejection;
    // the sending hub must not reinterpret a failed RPC acknowledgment.
    expect(next).toMatchObject({ outcome: "unknown" });
    expect(admitted).toHaveBeenCalledTimes(1);
    await expect(
      acceptExternalAgentRpc(subject, { ...request, attempt_id: randomUUID() }),
    ).rejects.toThrow();
  });

  test("home human approval, scoped discovery and explicit cross-owner reverse reply", async () => {
    await approve();
    const links = await context.run("source-bay", () =>
      acceptAgentRpc(agentMessagingSubject(source.agent_id, run), {
        version: 2,
        action: "destinations",
      }),
    );
    expect(links).toEqual([expect.objectContaining({ source, target })]);
    expect(await send()).toMatchObject({ outcome: "accepted" });
    expect(await send(target, source)).toMatchObject({ outcome: "rejected" });
    await approve(target, source);
    expect(await send(target, source)).toMatchObject({ outcome: "accepted" });
    expect(admitted).toHaveBeenCalledTimes(2);
    expect(admitted.mock.calls[0][0]).toMatchObject({
      account_id: account,
      source,
      target,
    });
    expect(
      routedCalls.some(
        (call) => call.bay === "target-bay" && call.method === "submit",
      ),
    ).toBe(true);
    expect(JSON.stringify(routedCalls)).not.toContain("human-home-session");
  });
  test("fresh auth failure creates no permission", async () => {
    fresh.mockRejectedValue(new Error("fresh auth required"));
    await expect(approve()).rejects.toThrow("fresh auth");
    expect(
      (await agentStore().query("SELECT * FROM agent_rpc_links")).rows,
    ).toHaveLength(0);
  });
  test("stopped targets route to their host for authorized startup", async () => {
    await approve();
    await agentStore().query(
      "UPDATE projects SET state='{}' WHERE project_id=$1",
      [targetProject],
    );
    try {
      expect(await send()).toMatchObject({ outcome: "accepted" });
      expect(admitted).toHaveBeenCalledTimes(1);
    } finally {
      await agentStore().query(
        `UPDATE projects SET state='{"state":"running"}' WHERE project_id=$1`,
        [targetProject],
      );
    }
  });
  test("revocation and expiry stop new admissions", async () => {
    const link = await approve();
    await revokeRpcLink({
      account_id: account,
      session_hash: "human-home-session",
      source,
      link_id: link.link_id,
    });
    expect(await send()).toMatchObject({ outcome: "rejected" });
    await approve();
    await agentStore().query(
      "UPDATE agent_rpc_links SET expires_at=now()-interval '1 second'",
    );
    expect(await send()).toMatchObject({ outcome: "rejected" });
    expect(admitted).not.toHaveBeenCalled();
  });
  test("lost host acknowledgment is unknown; read-only inspection does not resend", async () => {
    await approve();
    admitted.mockRejectedValue(new Error("ack lost"));
    expect(await send()).toMatchObject({ outcome: "unknown" });
    await context.run("source-bay", () =>
      acceptAgentRpc(agentMessagingSubject(source.agent_id, run), {
        version: 2,
        action: "inspect",
        attempt_id: randomUUID(),
        target,
      }),
    );
    expect(admitted).toHaveBeenCalledTimes(1);
  });

  const personalApproval = (extra = {}) =>
    grantPersonalConnection({
      account_id: account,
      session_hash: "home-only-secret",
      source,
      target,
      approval_request_id: randomUUID(),
      reason: "personal review",
      ...extra,
    });
  const scoped = (request, run_id = run) =>
    context.run("source-bay", () =>
      acceptAgentRpc(agentMessagingSubject(source.agent_id, run_id), {
        version: 2,
        ...request,
      }),
    );

  test("personal denials and bounded binary sends survive real Conat home/source/target serialization", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    const { init, ConatServer } = await import("@cocalc/conat/core/server");
    const { connect, Client } = await import("@cocalc/conat/core/client");
    const { once } = await import("node:events");
    const { createAgentRpcControlHandler, createAgentRpcControlClient } =
      jest.requireActual<typeof import("@cocalc/conat/inter-bay/agent-rpc")>(
        "@cocalc/conat/inter-bay/agent-rpc",
      );
    const server = init({
      port: 0,
      getUser: async () => ({ hub_id: "test-fabric" }),
    });
    const services: ReturnType<typeof createAgentRpcControlHandler>[] = [];
    let spy: jest.SpyInstance | undefined;
    try {
      wireClient = connect({ address: server.address(), noCache: true });
      await wireClient.waitUntilSignedIn({ timeout: 5000 });
      for (const bay of ["home", "source-bay", "target-bay"]) {
        const serviceClient = connect({
          address: server.address(),
          noCache: true,
        });
        await serviceClient.waitUntilSignedIn({ timeout: 5000 });
        const impl = Object.fromEntries(
          Object.keys(agentRpcControl).map((method) => [
            method,
            (opts) => context.run(bay, () => agentRpcControl[method](opts)),
          ]),
        ) as typeof agentRpcControl;
        const service = createAgentRpcControlHandler(bay, impl, {
          client: serviceClient,
          parallel: true,
        });
        services.push(service);
        await once(service, "running");
      }

      // These exercise the real store plus all three real request/reply hops.
      expect(await send()).toMatchObject({
        outcome: "rejected",
        reason: "approval_required",
      });
      const [grant] = await personalApproval();
      await agentStore().query(
        "UPDATE agent_personal_grants SET expires_at=now()-interval '1 second'",
      );
      expect(await send()).toMatchObject({
        outcome: "rejected",
        reason: "grant_expired",
      });
      await agentStore().query(
        "UPDATE agent_personal_grants SET expires_at=NULL",
      );
      await setPersonalConnectionState({
        account_id: account,
        direction_group_id: grant.direction_group_id,
        state: "paused",
      });
      expect(await send()).toMatchObject({
        outcome: "rejected",
        reason: "grant_paused",
      });
      await setPersonalConnectionState({
        account_id: account,
        direction_group_id: grant.direction_group_id,
        state: "revoked",
      });
      expect(await send()).toMatchObject({
        outcome: "rejected",
        reason: "grant_revoked",
      });

      const original = agentRpcControl.personal;
      let denial: import("@cocalc/conat/agents/personal").PersonalAgentDenialCode =
        "approval_required";
      spy = jest
        .spyOn(agentRpcControl, "personal")
        .mockImplementation(async (opts) =>
          opts.request.action === "check" ? { denied: denial } : original(opts),
        );
      for (const code of [
        "approval_required",
        "grant_expired",
        "grant_paused",
        "grant_revoked",
        "principal_mismatch",
        "account_disabled",
        "agent_unavailable",
      ] as const) {
        denial = code;
        expect(await send()).toMatchObject({
          outcome: "rejected",
          reason: code,
        });
      }

      // Exception messages really are decorated by each remote typed client.
      // An untyped exception must not be guessed back into a known denial.
      spy.mockImplementation(async () => {
        throw new Error("grant_paused");
      });
      const sourceClient = createAgentRpcControlClient(
        wireClient,
        "source-bay",
      );
      await expect(
        sourceClient.check({
          project_id: source.project_id,
          route: { bay_id: "source-bay", epoch: 1 },
          source,
          target,
          run_id: run,
          guidance: false,
        }),
      ).rejects.toThrow(
        "calling remote function 'check': Error: calling remote function 'personal': Error: grant_paused",
      );
      expect(await send()).toMatchObject({
        outcome: "rejected",
        reason: "Link, execution account or target host unavailable",
      });
      expect(admitted).not.toHaveBeenCalled();
      expect(beforeAdmission).not.toHaveBeenCalled();

      spy.mockRestore();
      spy = undefined;
      process.env.COCALC_AGENT_MESSAGING_ATTACHMENTS_ENABLED = "1";
      await personalApproval();
      const data = Buffer.alloc(32 * 1024 * 1024, 171);
      const metadata = {
        name: "max-size.bin",
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      };
      const attempt = {
        version: 2 as const,
        target,
        attempt_id: randomUUID(),
        body: "Read the binary snapshot",
        snapshot_manifest: [metadata],
      };
      const invoke = (request) =>
        context.run("source-bay", () =>
          acceptAgentRpc(agentMessagingSubject(source.agent_id, run), request),
        );
      const ready: any = await invoke({
        ...attempt,
        action: "prepare-attachments",
      });
      expect(ready.outcome).toBe("prepared");
      expect(admitted).not.toHaveBeenCalled();
      const preparedSend = {
        ...attempt,
        action: "send",
        attachment_reservation: ready.reservation_id,
        snapshot_payload: [{ ...metadata, data }],
      };
      expect(
        await invoke({ ...preparedSend, body: "changed after approval" }),
      ).toMatchObject({
        outcome: "rejected",
        code: "attachment_preparation_unavailable",
      });
      expect(admitted).not.toHaveBeenCalled();
      expect(await invoke(preparedSend)).toMatchObject({ outcome: "accepted" });
      expect(admitted).toHaveBeenCalledTimes(1);
      const [envelope, payload] = admitted.mock.calls[0];
      expect(envelope.snapshot_payload).toBeUndefined();
      expect(envelope.snapshot_manifest).toEqual([metadata]);
      expect(ArrayBuffer.isView(payload[0].data)).toBe(true);
      expect(payload[0].data.byteLength).toBe(data.byteLength);
      expect(createHash("sha256").update(payload[0].data).digest("hex")).toBe(
        metadata.sha256,
      );
      expect(await invoke(preparedSend)).toMatchObject({
        outcome: "rejected",
        code: "attachment_preparation_unavailable",
      });
      expect(admitted).toHaveBeenCalledTimes(1);
    } finally {
      spy?.mockRestore();
      for (const service of services) service.close();
      wireClient = undefined;
      Client.closeAllForTests();
      await ConatServer.closeAllForTests();
    }
  }, 60_000);

  test("personal dispatcher applies the home fence to reads, writes, and scoped authorization", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    homeFence.mockRejectedValue(new Error("account rehome is running"));
    await expect(listNamedAgents({ account_id: account })).rejects.toThrow(
      "account rehome is running",
    );
    await expect(personalApproval()).rejects.toThrow(
      "account rehome is running",
    );
    await expect(scoped({ action: "destinations" })).rejects.toThrow(
      "account rehome is running",
    );
    expect(await send()).toMatchObject({ outcome: "rejected" });
    expect(homeFence).toHaveBeenCalledWith(expect.anything(), account);
    expect(admitted).not.toHaveBeenCalled();
    expect(
      (await agentStore().query("SELECT * FROM agent_personal_controls")).rows,
    ).toHaveLength(0);
  });

  test("personal directory and grants are home authoritative; source/run and target owners remain routed", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    await context.run("target-bay", () =>
      nameAgent({ account_id: account, endpoint: target, name: "reviewer" }),
    );
    const links = await context.run("source-bay", () =>
      personalApproval({ both_directions: true, ttl_seconds: null }),
    );
    expect(links).toHaveLength(2);
    expect(await scoped({ action: "destinations" })).toMatchObject([
      {
        target_name: "reviewer",
        expires_at: null,
        principal_account_id: account,
      },
    ]);
    expect(await send()).toMatchObject({ outcome: "accepted" });
    expect(await send(target, source)).toMatchObject({ outcome: "accepted" });
    expect(
      routedCalls.some(
        (call) => call.bay === "home" && call.method === "personal",
      ),
    ).toBe(true);
    expect(
      routedCalls.some(
        (call) => call.bay === "source-bay" && call.method === "check",
      ),
    ).toBe(true);
    expect(JSON.stringify(routedCalls)).not.toContain("home-only-secret");
    expect(admitted.mock.calls[0][0].account_id).toBe(account);
  });

  test("personal principal is not registration provenance; other humans cannot discover, send, inspect, or spoof it", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    const otherRun = randomUUID();
    await agentStore().query(
      "INSERT INTO agent_identity_runs(agent_id,run_id,account_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
      [source.agent_id, otherRun, other, randomUUID()],
    );
    await agentStore().query(
      "UPDATE agent_identities SET created_by=$1 WHERE agent_id=$2",
      [other, target.agent_id],
    );
    try {
      await personalApproval();
      expect(await send()).toMatchObject({ outcome: "accepted" });
      expect(admitted.mock.calls[0][0].account_id).toBe(account);
      expect(await scoped({ action: "destinations" }, otherRun)).toEqual([]);
      expect(
        await scoped(
          { action: "send", attempt_id: randomUUID(), target, body: "no" },
          otherRun,
        ),
      ).toMatchObject({ outcome: "rejected", reason: "approval_required" });
      await expect(
        scoped({ action: "destinations", account_id: account }, otherRun),
      ).rejects.toThrow("unexpected");
      await expect(
        scoped(
          { action: "inspect", attempt_id: randomUUID(), target },
          otherRun,
        ),
      ).rejects.toThrow("approval_required");
      expect(inspected).not.toHaveBeenCalled();
      await scoped({ action: "inspect", attempt_id: randomUUID(), target });
      expect(inspected).toHaveBeenCalledWith(
        expect.objectContaining({ account_id: account }),
      );
    } finally {
      await agentStore().query(
        "UPDATE agent_identities SET created_by=$1 WHERE agent_id=$2",
        [account, target.agent_id],
      );
    }
  });

  test("personal mode never falls back to existing shared grants, including home outage", async () => {
    await approve();
    const legacy = (await agentStore().query("SELECT * FROM agent_rpc_links"))
      .rows;
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    expect(await send()).toMatchObject({
      outcome: "rejected",
      reason: "approval_required",
    });
    await personalApproval();
    offlineBay = "home";
    expect(await send()).toMatchObject({ outcome: "rejected" });
    await expect(scoped({ action: "destinations" })).rejects.toThrow("offline");
    expect(admitted).not.toHaveBeenCalled();
    expect(
      (await agentStore().query("SELECT * FROM agent_rpc_links")).rows,
    ).toEqual(legacy);
  });

  test("account controls are rechecked after target startup wait before admission", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    await personalApproval();
    beforeAdmission.mockImplementationOnce(async () => {
      await setPersonalMessagingState({ account_id: account, action: "pause" });
    });
    // The target transport was invoked, so a lost/failing acknowledgment remains
    // unknown at this boundary; it must never be recast as safe to retry.
    expect(await send()).toMatchObject({ outcome: "unknown" });
    expect(admitted).not.toHaveBeenCalled();
    expect(await send()).toMatchObject({
      outcome: "rejected",
      reason: "grant_paused",
    });
  });

  test("personal authorization is rechecked when an accepted RPC begins execution", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    const [grant] = await personalApproval();
    const identity = await agentStore().get(target.agent_id);
    const authorization = {
      version: 2 as const,
      source,
      source_run_id: run,
      target,
      target_path: identity.path,
      target_thread_id: identity.thread_id,
      link_id: grant.link_id,
      principal_account_id: account,
      guidance: false,
    };
    const authorize = () =>
      context.run("target-bay", () =>
        authorizeRpcExecution({
          account_id: account,
          host_id: hostId,
          authorization,
        }),
      );
    await authorize();
    await setPersonalMessagingState({ account_id: account, action: "pause" });
    await expect(authorize()).rejects.toThrow("grant_paused");
  });

  test("a pause does not claim to retract an already authorized in-flight admission", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    await personalApproval();
    admitted.mockImplementationOnce(async () => {
      await setPersonalMessagingState({ account_id: account, action: "pause" });
    });
    expect(await send()).toMatchObject({ outcome: "accepted" });
    expect(await send()).toMatchObject({
      outcome: "rejected",
      reason: "grant_paused",
    });
    expect(admitted).toHaveBeenCalledTimes(1);
  });

  test("fresh auth on restore, not restriction; stale home routes are rejected", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    const [grant] = await personalApproval();
    fresh.mockRejectedValue(new Error("fresh required"));
    await setPersonalConnectionState({
      account_id: account,
      direction_group_id: grant.direction_group_id,
      state: "paused",
    });
    await expect(
      setPersonalConnectionState({
        account_id: account,
        direction_group_id: grant.direction_group_id,
        state: "active",
      }),
    ).rejects.toThrow("fresh required");
    await setPersonalMessagingState({
      account_id: account,
      action: "revoke_all",
    });
    await expect(
      setPersonalMessagingState({ account_id: account, action: "resume" }),
    ).rejects.toThrow("fresh required");
    await expect(
      agentRpcControl.personal({
        account_id: account,
        home_bay_id: "stale",
        request: { action: "listNamedAgents", options: {} },
      }),
    ).rejects.toThrow("stale");
    await expect(
      agentRpcControl.personal({
        account_id: account,
        home_bay_id: "home",
        fresh_auth_at: 0,
        request: {
          action: "grantPersonalConnection",
          options: {
            source,
            target,
            approval_request_id: randomUUID(),
            reason: "bad attestation",
          },
        },
      }),
    ).rejects.toThrow("attestation");
  });

  test("scoped connection requests return typed records, require P's fresh approval, and never send", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    const request_id = randomUUID();
    expect(
      await scoped({
        action: "request-connection",
        request_id,
        target,
        reason: "please review",
        ttl_seconds: null,
        both_directions: true,
      }),
    ).toMatchObject({
      request_id,
      account_id: account,
      run_id: run,
      state: "pending",
      source,
      target,
    });
    await expect(
      resolvePersonalConnectionRequest({
        account_id: other,
        request_id,
        decision: "approve",
      }),
    ).rejects.toThrow("not_found");
    fresh.mockRejectedValueOnce(new Error("fresh required"));
    await expect(
      resolvePersonalConnectionRequest({
        account_id: account,
        request_id,
        decision: "approve",
      }),
    ).rejects.toThrow("fresh required");
    expect(
      await resolvePersonalConnectionRequest({
        account_id: account,
        request_id,
        decision: "approve",
      }),
    ).toMatchObject({ state: "approved" });
    expect(
      await scoped({ action: "connection-request", request_id }),
    ).toMatchObject({ state: "approved" });
    expect(admitted).not.toHaveBeenCalled();
    expect(inspected).not.toHaveBeenCalled();
    expect(await send()).toMatchObject({ outcome: "accepted" });
  });

  test("disabled personal mode keeps management reads but rejects new approvals", async () => {
    expect(await listNamedAgents({ account_id: account })).toEqual({
      enabled: false,
      agents: [],
      controls: { paused: false, generation: 0 },
    });
    expect(routedCalls).toEqual([]);
    await expect(personalApproval()).rejects.toThrow("not enabled");
  });

  test("master and personal kill switches preserve home-routed revocation without resume", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    const [grant] = await personalApproval();
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "0";
    process.env.COCALC_AGENT_MESSAGING_ENABLED = "0";
    try {
      const directory = await context.run("source-bay", () =>
        listPersonalConnections({ account_id: account }),
      );
      expect(directory.enabled).toBe(false);
      expect(directory.connections).toHaveLength(1);
      await context.run("source-bay", () =>
        setPersonalConnectionState({
          account_id: account,
          direction_group_id: grant.direction_group_id,
          state: "revoked",
        }),
      );
      expect(
        (await listPersonalConnections({ account_id: account })).connections[0]
          .status,
      ).toBe("revoked");
      await expect(
        setPersonalMessagingState({
          account_id: account,
          action: "resume",
          session_hash: "home-only-secret",
        }),
      ).rejects.toThrow("not enabled");
      expect(
        routedCalls.some(
          (call) => call.bay === "home" && call.method === "personal",
        ),
      ).toBe(true);
      expect(admitted).not.toHaveBeenCalled();
    } finally {
      process.env.COCALC_AGENT_MESSAGING_ENABLED = "1";
    }
  });

  test("telemetry failure cannot change acceptance or trigger another submission", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    await personalApproval();
    const original = agentRpcControl.personal;
    const spy = jest
      .spyOn(agentRpcControl, "personal")
      .mockImplementation(async (opts) => {
        if (opts.request.action === "observe")
          throw new Error("telemetry offline");
        return original(opts);
      });
    try {
      expect(await send()).toMatchObject({ outcome: "accepted" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        spy.mock.calls.some(([opts]) => opts.request.action === "observe"),
      ).toBe(true);
      expect(admitted).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("a personal target never accepts legacy check authority from an unenrolled source bay", async () => {
    await approve();
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    const original = agentRpcControl.check;
    const spy = jest
      .spyOn(agentRpcControl, "check")
      .mockImplementation(async (opts) => {
        delete process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED;
        try {
          return await original(opts);
        } finally {
          process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
        }
      });
    try {
      expect(await send()).toMatchObject({ outcome: "rejected" });
      await expect(
        scoped({ action: "inspect", attempt_id: randomUUID(), target }),
      ).rejects.toThrow("principal_mismatch");
      expect(admitted).not.toHaveBeenCalled();
      expect(inspected).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("pending approval invalidates if the source owner leaves personal mode", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    const request_id = randomUUID();
    await scoped({
      action: "request-connection",
      request_id,
      target,
      reason: "review",
    });
    const original = agentRpcControl.principal;
    const spy = jest
      .spyOn(agentRpcControl, "principal")
      .mockImplementation(async (opts) => ({
        ...(await original(opts)),
        personal_messaging: false,
      }));
    try {
      expect(
        await resolvePersonalConnectionRequest({
          account_id: account,
          request_id,
          decision: "approve",
        }),
      ).toMatchObject({ state: "invalidated" });
      expect(
        (await agentStore().query("SELECT * FROM agent_personal_grants")).rows,
      ).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test("scoped inspection of a coalesced submitted ID preserves that ID after resolution", async () => {
    process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = "1";
    const request_id = randomUUID(),
      submitted_id = randomUUID();
    const opts = {
      action: "request-connection",
      request_id,
      target,
      reason: "review",
      ttl_seconds: null,
      both_directions: true,
      allow_guidance: false,
    };
    await scoped(opts);
    expect(await scoped({ ...opts, request_id: submitted_id })).toMatchObject({
      request_id,
    });
    await resolvePersonalConnectionRequest({
      account_id: account,
      request_id,
      decision: "deny",
    });
    expect(await scoped({ ...opts, request_id: submitted_id })).toMatchObject({
      request_id,
      state: "denied",
    });
    expect(
      await scoped({ action: "connection-request", request_id: submitted_id }),
    ).toMatchObject({
      request_id: submitted_id,
      canonical_request_id: request_id,
      run_id: run,
      source,
      state: "denied",
    });
    expect(admitted).not.toHaveBeenCalled();
  });
});
