/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// A launch and a key replacement or removal serialize on the account fence:
// in either order, no pod can end up launched with a key that was replaced
// or removed. Needs concurrent transactions, hence a real PostgreSQL; skips
// itself without the server binaries.

import { randomUUID } from "node:crypto";
import {
  postgresBinDir,
  startRealPostgres,
  waitForLockWaiters,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (_name: string, value: string) => value,
  decryptSecretStorageValue: async (_name: string, value: string) => ({
    value,
  }),
}));

const describeRealPostgres = postgresBinDir() ? describe : describe.skip;

// lock waits are slow on a loaded machine (the full parallel run)
jest.setTimeout(30_000);

const OLD = "rpa_OLDKEY0123456789abcdefghijklmnopqrstuvwxyzAB";
const NEW = "rpa_NEWKEY0123456789abcdefghijklmnopqrstuvwxyzAB";

describeRealPostgres("GPU launches vs key replacement and removal", () => {
  let pg: RealPostgres;
  let getPool: any;
  let keys: typeof import("./provider-keys");
  let pods: typeof import("./pods");
  let store: typeof import("@cocalc/server/external-credentials/store");

  beforeAll(async () => {
    pg = startRealPostgres("gpu_key_lifecycle_test");
    getPool = (await import("@cocalc/database/pool")).default;
    const { SCHEMA } = await import("@cocalc/util/db-schema");
    const { syncSchema } =
      await import("@cocalc/database/postgres/schema/sync");
    // what the account write fence checks (home bay, not rehoming)
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS accounts (account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN)",
    );
    await syncSchema({
      external_credentials: SCHEMA.external_credentials,
      gpu_key_fences: SCHEMA.gpu_key_fences,
      gpu_key_events: SCHEMA.gpu_key_events,
      gpu_budget_layers: SCHEMA.gpu_budget_layers,
      gpu_budget_events: SCHEMA.gpu_budget_events,
      gpu_pods: SCHEMA.gpu_pods,
      gpu_pod_events: SCHEMA.gpu_pod_events,
      gpu_pod_reservations: SCHEMA.gpu_pod_reservations,
      gpu_worker_leases: SCHEMA.gpu_worker_leases,
      gpu_worker_overrides: SCHEMA.gpu_worker_overrides,
    });
    // a reaper that has just completed a pass (launches need one)
    await getPool().query(
      "INSERT INTO gpu_worker_leases (name, last_completed_at) VALUES ('reaper', now() + interval '10 years') ON CONFLICT (name) DO UPDATE SET last_completed_at = EXCLUDED.last_completed_at",
    );
    keys = await import("./provider-keys");
    pods = await import("./pods");
    store = await import("@cocalc/server/external-credentials/store");
  }, 120_000);

  afterAll(async () => {
    try {
      await getPool?.().end();
    } finally {
      pg?.stop();
    }
  });

  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };

  async function setup() {
    const account_id = randomUUID();
    // homed on this bay (no home_bay_id means the local bay)
    await getPool().query("INSERT INTO accounts (account_id) VALUES ($1)", [
      account_id,
    ]);
    await store.upsertExternalCredential({
      selector: {
        provider: "runpod",
        kind: "gpu-provider-api-key",
        scope: "account",
        owner_account_id: account_id,
      },
      payload: OLD,
      metadata: {
        provider_account_kind: "personal",
        provider_account_id: "u1",
      },
    });
    // One fake RunPod for verification and creates; records the key used.
    const used: string[] = [];
    // RunPod stops answering terminates (until the caller aborts)
    const stall = { terminate: false, identity: false };
    const fetch = (async (url: string, init: any) => {
      const auth = `${init?.headers?.Authorization ?? ""}`.replace(
        "Bearer ",
        "",
      );
      const path = new URL(url).pathname;
      const json = (status: number, body: unknown) =>
        new Response(status === 204 ? null : JSON.stringify(body), { status });
      if (path === "/v2/pods" && init?.method === "POST") {
        used.push(auth);
        const body = JSON.parse(init.body);
        return json(201, {
          id: `pod_${randomUUID().slice(0, 8)}`,
          name: body.name,
        });
      }
      if (
        stall.terminate &&
        init?.method === "DELETE" &&
        path.startsWith("/v2/pods/")
      ) {
        return await new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal.reason ?? Error("aborted")),
          ),
        );
      }
      // a personal account's identity takes two requests: a slow
      // organization answer, then a GraphQL call that never answers
      if (stall.identity && path === "/v2/organization") {
        await new Promise((r) => setTimeout(r, 2_500));
      }
      if (stall.identity && path === "/graphql") {
        return await new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal.reason ?? Error("aborted")),
          ),
        );
      }
      if (path === "/v2/organization") {
        return json(403, {
          detail: "Organizations are not enabled for this user",
        });
      }
      if (path === "/graphql")
        return json(200, { data: { myself: { id: "u1" } } });
      if (path === "/v2/pods") {
        return json(200, { pods: [], pagination: { hasNextPage: false } });
      }
      if (path === "/v2/templates" && init?.method === "POST") {
        return json(201, { id: "tpl_1" });
      }
      if (path.startsWith("/v2/templates/")) return json(204, "");
      return json(404, {});
    }) as unknown as typeof globalThis.fetch;
    const keyDeps = {
      fetch,
      isEntitled: async () => true,
      isHomeBay: async () => true,
    };
    return { account_id, used, fetch, keyDeps, stall };
  }

  function launch(
    s: Awaited<ReturnType<typeof setup>>,
    waitFor?: Promise<void>,
    underFence?: () => void,
  ) {
    let reads = 0;
    return pods.launchGpuPodLocal(
      {
        account_id: s.account_id,
        project_id: "00000000-1000-4000-8000-0000000000aa",
        spec: {
          gpu_type_id: "NVIDIA GeForce RTX 4090",
          image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
          max_runtime_minutes: 60,
        },
      },
      {
        isHomeBay: async () => true,
        isProjectCollaborator: async () => true,
        // the second read is the one under the account fence (the first
        // prices the launch, after a fence check of its own)
        getLaunchAccess: async (account_id) => {
          reads += 1;
          if (reads === 2) {
            underFence?.();
            await waitFor;
          }
          return await keys.getRunpodLaunchAccessForAccount(
            account_id,
            s.keyDeps,
          );
        },
        listPrice: async () => 0.5,
      },
    );
  }

  const query = (sql: string) => getPool().query(sql);

  // until some transaction holds the account fence (an advisory lock)
  async function fenceHeld() {
    for (let i = 0; i < 500; i++) {
      const { rows } = await query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted",
      );
      if (rows[0].n > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("nobody took the fence");
  }

  // pauses only the check made under the fence (the second one, for a
  // replacement, which also checks before verifying with RunPod)
  function pauseUnderFence(g: { p: Promise<void> }, calls: number) {
    let n = 0;
    return async () => {
      n += 1;
      if (n === calls) await g.p;
      return 0;
    };
  }

  async function storedKey(account_id: string) {
    const r = await store.getExternalCredential({
      selector: {
        provider: "runpod",
        kind: "gpu-provider-api-key",
        scope: "account",
        owner_account_id: account_id,
      },
    });
    return r?.revoked ? undefined : r?.payload;
  }

  it("launch first: the replacement waits, then is refused; the pod used the old key", async () => {
    const s = await setup();
    const g = gate();
    const held = gate();
    const launching = launch(s, g.p, held.open);
    // the launch holds the fence (waiting on its gate); the replacement
    // verifies with RunPod and then waits for the fence
    await held.p;
    const replacing = keys.setGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod", api_key: NEW },
      s.keyDeps,
    );
    await waitForLockWaiters(query, 1);
    g.open();
    await launching;
    await expect(replacing).rejects.toThrow(
      "launched with your current RunPod key",
    );
    expect(s.used).toEqual([OLD]);
    expect(await storedKey(s.account_id)).toBe(OLD);
  });

  it("replacement first: the launch waits, then uses the new key", async () => {
    const s = await setup();
    const g = gate();
    const replacing = keys.setGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod", api_key: NEW },
      {
        ...s.keyDeps,
        // holds the fence until opened
        unfinishedPods: pauseUnderFence(g, 2),
      },
    );
    // wait until the replacement holds the fence
    await fenceHeld();
    const launching = launch(s);
    await waitForLockWaiters(query, 1);
    g.open();
    await replacing;
    await launching;
    expect(s.used).toEqual([NEW]);
    expect(await storedKey(s.account_id)).toBe(NEW);
  });

  it("launch first: the removal waits, then drains the pod and removes the key", async () => {
    const s = await setup();
    const g = gate();
    const held = gate();
    const launching = launch(s, g.p, held.open);
    await held.p;
    const removing = keys.deleteGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod" },
      s.keyDeps,
    );
    await waitForLockWaiters(query, 1);
    g.open();
    const pod = await launching;
    // the removal terminates the pod with the old key, then removes it
    expect(await removing).toEqual({ revoked: true });
    expect(s.used).toEqual([OLD]);
    expect(await storedKey(s.account_id)).toBeUndefined();
    const { rows } = await getPool().query(
      "SELECT state FROM gpu_pods WHERE id = $1",
      [pod.id],
    );
    expect(rows[0].state).toBe("terminated");
  });

  it("a key replaced in place between pricing and the fence refuses the launch", async () => {
    const s = await setup();
    let reads = 0;
    const launching = pods.launchGpuPodLocal(
      {
        account_id: s.account_id,
        project_id: "00000000-1000-4000-8000-0000000000aa",
        spec: {
          gpu_type_id: "NVIDIA GeForce RTX 4090",
          image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
          max_runtime_minutes: 60,
        },
      },
      {
        isHomeBay: async () => true,
        isProjectCollaborator: async () => true,
        getLaunchAccess: async (account_id) => {
          const access = await keys.getRunpodLaunchAccessForAccount(
            account_id,
            s.keyDeps,
          );
          // right after pricing read the old key, it is replaced in place
          // (the record keeps its id)
          if (++reads === 1) {
            await keys.setGpuProviderKeyLocal(
              { account_id, provider: "runpod", api_key: NEW },
              s.keyDeps,
            );
          }
          return access;
        },
        listPrice: async () => 0.5,
      },
    );
    await expect(launching).rejects.toThrow(
      "Your RunPod API key changed during the launch",
    );
    expect(s.used).toEqual([]);
    expect(await storedKey(s.account_id)).toBe(NEW);
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM gpu_pods WHERE key_owner_account_id = $1",
      [s.account_id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("removal first: the launch waits, then finds no key and records nothing", async () => {
    const s = await setup();
    const g = gate();
    // the removal's last check (under the fence) waits on the gate
    let calls = 0;
    const removing = keys.deleteGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod" },
      {
        ...s.keyDeps,
        credentialPods: async (credential_id) => {
          if (++calls === 3) await g.p;
          return await pods.unfinishedCredentialPods(credential_id);
        },
      },
    );
    await fenceHeld();
    const launching = launch(s);
    await waitForLockWaiters(query, 1);
    g.open();
    expect(await removing).toEqual({ revoked: true });
    // refused whichever fence turn it got: draining (between the removal's
    // fenced phases, on a loaded machine), closed (before the revocation
    // lands), or no key
    await expect(launching).rejects.toThrow(
      /No RunPod API key is connected|This RunPod key was removed|This RunPod key is being removed/,
    );
    expect(s.used).toEqual([]);
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM gpu_pods WHERE key_owner_account_id = $1",
      [s.account_id],
    );
    expect(rows[0].n).toBe(0);
  });

  // Holds the account fence in its own transaction (as a rehome would),
  // moves the account to another bay meanwhile, then lets go.
  async function cutoverWhileWaiting(account_id: string, waiters: number) {
    const db = await getPool().connect();
    await db.query("BEGIN");
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
      ["account-rehome", account_id],
    );
    return {
      db,
      async cutover() {
        await waitForLockWaiters(query, waiters);
        await db.query(
          "UPDATE accounts SET home_bay_id = 'bay-elsewhere' WHERE account_id = $1",
          [account_id],
        );
        await db.query("COMMIT");
        db.release();
      },
    };
  }

  it("a launch that waited behind a rehome cutover is refused under the fence, reading no key", async () => {
    const s = await setup();
    const rehome = await cutoverWhileWaiting(s.account_id, 1);
    const read = jest.fn();
    const launching = pods.launchGpuPodLocal(
      {
        account_id: s.account_id,
        project_id: "00000000-1000-4000-8000-0000000000aa",
        spec: {
          gpu_type_id: "NVIDIA GeForce RTX 4090",
          image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
          max_runtime_minutes: 60,
        },
      },
      {
        // passed before waiting: the account was homed here then
        isHomeBay: async () => true,
        isProjectCollaborator: async () => true,
        getLaunchAccess: async (a) => {
          read();
          return await keys.getRunpodLaunchAccessForAccount(a, s.keyDeps);
        },
        listPrice: async () => 0.5,
      },
    );
    await rehome.cutover();
    await expect(launching).rejects.toThrow(
      "account is homed on bay-elsewhere",
    );
    expect(read).not.toHaveBeenCalled();
    expect(s.used).toEqual([]);
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM gpu_pods WHERE key_owner_account_id = $1",
      [s.account_id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("a key removal that waited behind a rehome cutover is refused, leaving the key", async () => {
    const s = await setup();
    const rehome = await cutoverWhileWaiting(s.account_id, 1);
    const removing = keys.deleteGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod" },
      s.keyDeps,
    );
    await rehome.cutover();
    await expect(removing).rejects.toThrow("account is homed on bay-elsewhere");
    expect(await storedKey(s.account_id)).toBe(OLD);
  });

  it("launches and key changes are refused while the account's rehome is frozen", async () => {
    const s = await setup();
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS account_financial_handoffs (account_id UUID, state TEXT)",
    );
    await getPool().query(
      "INSERT INTO account_financial_handoffs (account_id, state) VALUES ($1, 'frozen')",
      [s.account_id],
    );
    try {
      await expect(launch(s)).rejects.toThrow("rehome is frozen");
      await expect(
        keys.deleteGpuProviderKeyLocal(
          { account_id: s.account_id, provider: "runpod" },
          s.keyDeps,
        ),
      ).rejects.toThrow("rehome is frozen");
      expect(s.used).toEqual([]);
      expect(await storedKey(s.account_id)).toBe(OLD);
    } finally {
      await getPool().query(
        "DELETE FROM account_financial_handoffs WHERE account_id = $1",
        [s.account_id],
      );
    }
  });

  it("removing a rejected key and connecting another gives a new identity that can't act on the old pods", async () => {
    const s = await setup();
    const pod = await launch(s);
    const before = (await keys.getRunpodLaunchAccessForAccount(
      s.account_id,
      s.keyDeps,
    ))!.credential_id;
    // the old key was deleted at RunPod: removing it leaves the pod unmanaged
    expect(
      await keys.deleteGpuProviderKeyLocal(
        { account_id: s.account_id, provider: "runpod" },
        { ...s.keyDeps, storedKeyRejected: async () => true },
      ),
    ).toEqual(
      expect.objectContaining({ revoked: true, unmanaged: [pod.handle] }),
    );
    await keys.setGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod", api_key: NEW },
      s.keyDeps,
    );
    const after = (await keys.getRunpodLaunchAccessForAccount(
      s.account_id,
      s.keyDeps,
    ))!.credential_id;
    expect(after).not.toBe(before);
    // the old pod's record is left alone, never acted on with the new key
    await expect(
      pods.terminateGpuPodLocal(
        { account_id: s.account_id, pod_id: pod.handle },
        {
          isHomeBay: async () => true,
          getCleanup: (a) => keys.getRunpodCleanupForAccount(a, s.keyDeps),
        },
      ),
    ).rejects.toThrow("since been replaced");
    const { rows } = await getPool().query(
      "SELECT state, credential_id FROM gpu_pods WHERE id = $1",
      [pod.id],
    );
    expect(rows[0]).toEqual({ state: "running", credential_id: before });
  });

  const SHORT_END = new Date(Date.now() + 7 * 24 * 3600 * 1000);

  it("a replacement is a new credential: the old key is revoked and its fence closed, and only its remaining money carries over", async () => {
    const s = await setup();
    const pod = await launch(s);
    const before = (await keys.getRunpodLaunchAccessForAccount(
      s.account_id,
      s.keyDeps,
    ))!.credential_id;
    // the pod ended, having spent $15 of the key's $20
    await getPool().query(
      "UPDATE gpu_pods SET state = 'terminated', desired_state = 'terminated' WHERE id = $1",
      [pod.id],
    );
    await getPool().query(
      "UPDATE gpu_budget_layers SET spent_usd = 15, reserved_usd = 0, ends_at = $2 WHERE credential_id = $1 AND scope_kind = 'key'",
      [before, SHORT_END],
    );
    await getPool().query(
      "UPDATE gpu_key_fences SET kill_switch_at = now() WHERE credential_id = $1",
      [before],
    );
    await keys.setGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod", api_key: NEW },
      s.keyDeps,
    );
    const after = (await keys.getRunpodLaunchAccessForAccount(
      s.account_id,
      s.keyDeps,
    ))!.credential_id;
    expect(after).not.toBe(before);
    expect(await storedKey(s.account_id)).toBe(NEW);
    const { rows: fences } = await getPool().query(
      "SELECT credential_id, state FROM gpu_key_fences WHERE key_owner_account_id = $1",
      [s.account_id],
    );
    expect(
      Object.fromEntries(fences.map((f) => [f.credential_id, f.state])),
    ).toEqual({ [before]: "closed", [after]: "active" });
    const { rows: layer } = await getPool().query(
      "SELECT authorized_usd, ends_at FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key'",
      [after],
    );
    expect(Number(layer[0].authorized_usd)).toBe(5);
    // the kill switch's pause outlives the rotation
    const { rows: fence } = await getPool().query(
      "SELECT kill_switch_at FROM gpu_key_fences WHERE credential_id = $1",
      [after],
    );
    expect(fence[0].kill_switch_at).not.toBeNull();
    // a budget its owner shortened stays as short
    expect(new Date(layer[0].ends_at).getTime()).toBe(SHORT_END.getTime());
    const { rows: log } = await getPool().query(
      "SELECT action, details FROM gpu_key_events WHERE credential_id = $1",
      [before],
    );
    expect(log).toEqual([{ action: "removed", details: { replaced: true } }]);
  });

  it("a key whose budget already ended can be replaced; the new key's budget stays ended", async () => {
    const s = await setup();
    const pod = await launch(s);
    const before = (await keys.getRunpodLaunchAccessForAccount(
      s.account_id,
      s.keyDeps,
    ))!.credential_id;
    await getPool().query(
      "UPDATE gpu_pods SET state = 'terminated', desired_state = 'terminated' WHERE id = $1",
      [pod.id],
    );
    const day = 24 * 3600 * 1000;
    const starts = new Date(Date.now() - 10 * day);
    const ends = new Date(Date.now() - day);
    await getPool().query(
      "UPDATE gpu_budget_layers SET reserved_usd = 0, starts_at = $2, ends_at = $3 WHERE credential_id = $1 AND scope_kind = 'key'",
      [before, starts, ends],
    );
    await keys.setGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod", api_key: NEW },
      s.keyDeps,
    );
    const after = (await keys.getRunpodLaunchAccessForAccount(
      s.account_id,
      s.keyDeps,
    ))!.credential_id;
    expect(after).not.toBe(before);
    const { rows: layer } = await getPool().query(
      "SELECT starts_at, ends_at FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key'",
      [after],
    );
    expect(new Date(layer[0].starts_at).getTime()).toBe(starts.getTime());
    expect(new Date(layer[0].ends_at).getTime()).toBe(ends.getTime());
    await expect(launch(s)).rejects.toThrow();
  });

  it("replacement first: a removal that waited acts on nothing stale; it refuses, and the new key stays", async () => {
    const s = await setup();
    const g = gate();
    const replacing = keys.setGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod", api_key: NEW },
      { ...s.keyDeps, unfinishedPods: pauseUnderFence(g, 2) },
    );
    await fenceHeld();
    // the removal read the old key before the replacement committed
    const removing = keys.deleteGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod" },
      s.keyDeps,
    );
    await waitForLockWaiters(query, 1);
    g.open();
    await replacing;
    await expect(removing).rejects.toThrow(
      "changed while it was being removed",
    );
    expect(await storedKey(s.account_id)).toBe(NEW);
  });

  it("replacement first: a compromise report that waited refuses, and the new key stays active", async () => {
    const s = await setup();
    const compromise = await import("./compromise");
    const g = gate();
    // the report captures the old key's cleanup capability first
    const stale = await keys.getRunpodCleanupForAccount(
      s.account_id,
      s.keyDeps,
    );
    const replacing = keys.setGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod", api_key: NEW },
      { ...s.keyDeps, unfinishedPods: pauseUnderFence(g, 2) },
    );
    await fenceHeld();
    const reporting = compromise.reportCompromisedLocal(
      {
        account_id: s.account_id,
        confirm_cocalc_only: true,
        fresh_auth_verified: true,
      },
      { getCleanup: async () => stale },
    );
    await waitForLockWaiters(query, 1);
    g.open();
    await replacing;
    await expect(reporting).rejects.toThrow(
      "changed while this was being reported",
    );
    const after = (await keys.getRunpodLaunchAccessForAccount(
      s.account_id,
      s.keyDeps,
    ))!.credential_id;
    const { rows } = await getPool().query(
      "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
      [after],
    );
    expect(rows[0].state).toBe("active");
  });

  it("removal closes, then a report comes in before the revoke: the report refuses and claims nothing; the removal still revokes", async () => {
    const s = await setup();
    const compromise = await import("./compromise");
    const before = (await keys.getRunpodLaunchAccessForAccount(
      s.account_id,
      s.keyDeps,
    ))!.credential_id;
    const cleanup = await keys.getRunpodCleanupForAccount(
      s.account_id,
      s.keyDeps,
    );
    let reported: unknown;
    const removal = await keys.deleteGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod" },
      {
        ...s.keyDeps,
        // in the revocation, after the removal's fence committed the close
        clearHostkeys: async () => {
          reported = await compromise
            .reportCompromisedLocal(
              {
                account_id: s.account_id,
                confirm_cocalc_only: true,
                fresh_auth_verified: true,
              },
              { getCleanup: async () => cleanup },
            )
            .catch((err) => err);
        },
      },
    );
    expect(removal).toEqual({ revoked: true });
    expect(`${reported}`).toContain("already removed from CoCalc");
    const { rows } = await getPool().query(
      "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
      [before],
    );
    expect(rows[0].state).toBe("closed");
    const { rows: log } = await getPool().query(
      "SELECT action FROM gpu_key_events WHERE credential_id = $1 ORDER BY at",
      [before],
    );
    expect(log.map((l) => l.action)).not.toContain("compromised");
    expect(await storedKey(s.account_id)).toBeUndefined();
  });

  it("a removal whose RunPod terminates stall still answers in time, with the remaining pods", async () => {
    const s = await setup();
    const pod = await launch(s);
    s.stall.terminate = true;
    const started = Date.now();
    const result = await keys.deleteGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod" },
      { ...s.keyDeps, drainMs: 1_000, drainPollMs: 100 },
    );
    // the stalled call was cut at the removal's per-call timeout, not
    // RunPod's 30 s default
    expect(Date.now() - started).toBeLessThan(
      keys.KEY_REMOVAL_CALL_TIMEOUT_MS + 4_000,
    );
    expect(result).toEqual({ revoked: false, remaining: [pod.handle] });
  });

  it("a slow rejection probe comes out of the removal's drain, not on top of it", async () => {
    const s = await setup();
    const pod = await launch(s);
    s.stall.terminate = true;
    s.stall.identity = true;
    const drainMs = 3_000;
    const started = Date.now();
    const result = await keys.deleteGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod" },
      { ...s.keyDeps, drainMs, drainPollMs: 100 },
    );
    // the probe alone outlasts the drain (2.5 s, then the 4 s GraphQL
    // timeout), so no terminate starts after it: done without the 5 s of a
    // stalled call on top
    expect(Date.now() - started).toBeLessThan(
      drainMs + keys.KEY_REMOVAL_CALL_TIMEOUT_MS,
    );
    expect(result).toEqual({ revoked: false, remaining: [pod.handle] });
  });
});
