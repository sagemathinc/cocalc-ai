import assert from "node:assert/strict";
import test from "node:test";

import { createHubApiForContext, hubCallByName } from "./context";

test("createHubApiForContext exposes the notifications hub group", async () => {
  const calls: Array<{ name: string; args: any[]; timeout?: number }> = [];
  const callByName = async <T>(
    name: string,
    args: any[] = [],
    timeout?: number,
  ): Promise<T> => {
    calls.push({ name, args, timeout });
    return { ok: true } as T;
  };
  const hub = createHubApiForContext(callByName);

  const result = await hub.notifications.counts({ account_id: "acct-1" });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    {
      name: "notifications.counts",
      args: [{ account_id: "acct-1" }],
      timeout: undefined,
    },
  ]);
});

test("createHubApiForContext exposes the adminDb hub group", async () => {
  const calls: Array<{ name: string; args: any[]; timeout?: number }> = [];
  const hub = createHubApiForContext(async <T>(name, args = [], timeout) => {
    calls.push({ name, args, timeout });
    return { audit_id: "audit-1", rows: [] } as T;
  });

  const result = await hub.adminDb.diagnostic({
    diagnostic: "lro",
    params: { kind: "host-reconcile-software" },
  });

  assert.deepEqual(result, { audit_id: "audit-1", rows: [] });
  assert.deepEqual(calls, [
    {
      name: "adminDb.diagnostic",
      args: [
        {
          diagnostic: "lro",
          params: { kind: "host-reconcile-software" },
        },
      ],
      timeout: undefined,
    },
  ]);
});

test("createHubApiForContext exposes the adminHost hub group", async () => {
  const calls: Array<{ name: string; args: any[]; timeout?: number }> = [];
  const hub = createHubApiForContext(async <T>(name, args = [], timeout) => {
    calls.push({ name, args, timeout });
    return { audit_id: "audit-host-1", text: "" } as T;
  });

  const result = await hub.adminHost.logs({
    host_id: "11111111-1111-4111-8111-111111111111",
    source: "host-agent",
  });

  assert.deepEqual(result, { audit_id: "audit-host-1", text: "" });
  assert.deepEqual(calls, [
    {
      name: "adminHost.logs",
      args: [
        {
          host_id: "11111111-1111-4111-8111-111111111111",
          source: "host-agent",
        },
      ],
      timeout: undefined,
    },
  ]);
});

test("createHubApiForContext exposes the adminSupport hub group", async () => {
  const calls: Array<{ name: string; args: any[]; timeout?: number }> = [];
  const hub = createHubApiForContext(async <T>(name, args = [], timeout) => {
    calls.push({ name, args, timeout });
    return { audit_id: "audit-support-1", tickets: [] } as T;
  });

  const result = await hub.adminSupport.triage({
    since_minutes: 60,
    limit: 3,
    reason: "investigate recent support signals",
  });

  assert.deepEqual(result, {
    audit_id: "audit-support-1",
    tickets: [],
  });
  assert.deepEqual(calls, [
    {
      name: "adminSupport.triage",
      args: [
        {
          since_minutes: 60,
          limit: 3,
          reason: "investigate recent support signals",
        },
      ],
      timeout: undefined,
    },
  ]);
});

test("createHubApiForContext exposes the adminCrashes hub group", async () => {
  const calls: Array<{ name: string; args: any[]; timeout?: number }> = [];
  const hub = createHubApiForContext(async <T>(name, args = [], timeout) => {
    calls.push({ name, args, timeout });
    return { audit_id: "audit-crash-1", groups: [] } as T;
  });

  await hub.adminCrashes.triage({
    since_minutes: 60,
    reason: "investigate browser crashes",
  });

  assert.deepEqual(calls, [
    {
      name: "adminCrashes.triage",
      args: [{ since_minutes: 60, reason: "investigate browser crashes" }],
      timeout: undefined,
    },
  ]);
});

test("createHubApiForContext exposes the compute hub group", async () => {
  const calls: Array<{ name: string; args: any[]; timeout?: number }> = [];
  const hub = createHubApiForContext(async <T>(name, args = [], timeout) => {
    calls.push({ name, args, timeout });
    return [] as T;
  });

  const result = await hub.compute.listVms({
    project_id: "11111111-1111-4111-8111-111111111111",
  });

  assert.deepEqual(result, []);
  assert.deepEqual(calls, [
    {
      name: "compute.listVms",
      args: [
        {
          project_id: "11111111-1111-4111-8111-111111111111",
        },
      ],
      timeout: undefined,
    },
  ]);
});

test("createHubApiForContext forwards explicit per-call timeout", async () => {
  const calls: Array<{ name: string; args: any[]; timeout?: number }> = [];
  const hub = createHubApiForContext(async <T>(name, args = [], timeout) => {
    calls.push({ name, args, timeout });
    return { ok: true } as T;
  });

  await (hub.hosts.updateHostMachine as any)({
    id: "host-1",
    shared_disk_gb: 100,
    timeout: 120_000,
  });

  assert.deepEqual(calls, [
    {
      name: "hosts.updateHostMachine",
      args: [{ id: "host-1", shared_disk_gb: 100, timeout: 120_000 }],
      timeout: 120_000,
    },
  ]);
});

test("hubCallByName forwards auth_session_hash from the remote user", async () => {
  const calls: Array<Record<string, unknown>> = [];

  await hubCallByName({
    ctx: {
      timeoutMs: 15_000,
      rpcTimeoutMs: 15_000,
      accountId: "acct-1",
      remote: {
        client: {} as any,
        user: {
          auth_session_hash: "session-hash-1",
        },
      },
    },
    name: "system.createImpersonationGrant",
    args: [{ subject_account_id: "acct-2" }],
    callHub: async (opts) => {
      calls.push(opts);
      return { ok: true };
    },
  });

  assert.deepEqual(calls, [
    {
      client: {},
      account_id: "acct-1",
      auth_session_hash: "session-hash-1",
      name: "system.createImpersonationGrant",
      args: [{ subject_account_id: "acct-2" }],
      timeout: 15_000,
    },
  ]);
});

test("hubCallByName routes project-scoped auth through the project subject", async () => {
  const calls: Array<Record<string, unknown>> = [];

  await hubCallByName({
    ctx: {
      timeoutMs: 15_000,
      rpcTimeoutMs: 15_000,
      accountId: "00000000-1000-4000-8000-000000000001",
      remote: {
        client: {} as any,
        user: {
          project_id: "af027aca-e308-41c2-b528-a3e73de50996",
        },
      },
    },
    name: "compute.authorizeProjectSshKey",
    args: [
      {
        project_id: "af027aca-e308-41c2-b528-a3e73de50996",
        id_or_name: "compute-vm",
      },
    ],
    callHub: async (opts) => {
      calls.push(opts);
      return { ok: true };
    },
  });

  assert.deepEqual(calls, [
    {
      client: {},
      project_id: "af027aca-e308-41c2-b528-a3e73de50996",
      auth_session_hash: null,
      name: "compute.authorizeProjectSshKey",
      args: [
        {
          project_id: "af027aca-e308-41c2-b528-a3e73de50996",
          id_or_name: "compute-vm",
        },
      ],
      timeout: 15_000,
    },
  ]);
});

test("hubCallByName routes agent auth through the fingerprint-bound subject", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const accountId = "00000000-1000-4000-8000-000000000001";
  const projectId = "af027aca-e308-41c2-b528-a3e73de50996";
  const fingerprint = "a".repeat(64);
  await hubCallByName({
    ctx: {
      timeoutMs: 15_000,
      rpcTimeoutMs: 15_000,
      accountId,
      remote: {
        client: {} as any,
        user: {
          auth_actor: "agent",
          auth_project_id: projectId,
          auth_token_fingerprint: fingerprint,
          auth_iat_s: 100,
          auth_exp_s: 1000,
        },
      },
    },
    name: "compute.listProjectVms",
    args: [{}],
    callHub: async (opts) => {
      calls.push(opts);
      return [];
    },
  });
  assert.deepEqual(calls[0]?.agent, {
    account_id: accountId,
    project_id: projectId,
    token_fingerprint: fingerprint,
    issued_at_s: 100,
    expires_at_s: 1000,
  });
  assert.equal(calls[0]?.account_id, undefined);
  assert.equal(calls[0]?.project_id, undefined);
});

test("hubCallByName lets explicit timeouts exceed the default rpc timeout", async () => {
  const calls: Array<Record<string, unknown>> = [];

  await hubCallByName({
    ctx: {
      timeoutMs: 600_000,
      rpcTimeoutMs: 30_000,
      accountId: "acct-1",
      remote: {
        client: {} as any,
      },
    },
    name: "hosts.updateHostMachine",
    args: [{ id: "host-1", timeout: 120_000 }],
    timeout: 120_000,
    callHub: async (opts) => {
      calls.push(opts);
      return { ok: true };
    },
  });

  assert.equal(calls[0].timeout, 120_000);
});

test("hubCallByName lets a command-specific timeout exceed global defaults", async () => {
  const calls: Array<Record<string, unknown>> = [];

  await hubCallByName({
    ctx: {
      timeoutMs: 30_000,
      rpcTimeoutMs: 30_000,
      accountId: "acct-1",
      remote: { client: {} as any },
    },
    name: "system.runBayRestoreTest",
    args: [{ timeout: 3 * 60 * 60 * 1000 }],
    timeout: 3 * 60 * 60 * 1000,
    callHub: async (opts) => {
      calls.push(opts);
      return { ok: true };
    },
  });

  assert.equal(calls[0].timeout, 3 * 60 * 60 * 1000);
});
