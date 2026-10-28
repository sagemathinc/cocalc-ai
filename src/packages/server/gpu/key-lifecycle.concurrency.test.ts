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
    await syncSchema({
      external_credentials: SCHEMA.external_credentials,
      gpu_pods: SCHEMA.gpu_pods,
      gpu_pod_events: SCHEMA.gpu_pod_events,
    });
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
    return { account_id, used, fetch, keyDeps };
  }

  function launch(
    s: Awaited<ReturnType<typeof setup>>,
    waitFor?: Promise<void>,
  ) {
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
        // called under the account fence
        getLaunchAccess: async (account_id) => {
          await waitFor;
          return await keys.getRunpodLaunchAccessForAccount(
            account_id,
            s.keyDeps,
          );
        },
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
    const launching = launch(s, g.p);
    // the launch holds the fence (waiting on its gate); the replacement
    // verifies with RunPod and then waits for the fence
    await fenceHeld();
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

  it("launch first: the removal waits, then is refused", async () => {
    const s = await setup();
    const g = gate();
    const launching = launch(s, g.p);
    await fenceHeld();
    const removing = keys.deleteGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod" },
      s.keyDeps,
    );
    await waitForLockWaiters(query, 1);
    g.open();
    await launching;
    await expect(removing).rejects.toThrow("can't be removed yet");
    expect(await storedKey(s.account_id)).toBe(OLD);
  });

  it("removal first: the launch waits, then finds no key and records nothing", async () => {
    const s = await setup();
    const g = gate();
    const removing = keys.deleteGpuProviderKeyLocal(
      { account_id: s.account_id, provider: "runpod" },
      {
        ...s.keyDeps,
        unfinishedPods: pauseUnderFence(g, 1),
      },
    );
    await fenceHeld();
    const launching = launch(s);
    await waitForLockWaiters(query, 1);
    g.open();
    expect(await removing).toEqual({ revoked: true });
    await expect(launching).rejects.toThrow("No RunPod API key is connected");
    expect(s.used).toEqual([]);
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM gpu_pods WHERE key_owner_account_id = $1",
      [s.account_id],
    );
    expect(rows[0].n).toBe(0);
  });
});
