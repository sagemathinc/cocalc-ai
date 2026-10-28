/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// A pod's one-time host-key report and gpu.sshInfo, against a real (PGlite)
// database and a fake RunPod: the contract in HOSTKEY-REGISTRATION.md.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { GPU_LAUNCH_IMAGES } from "@cocalc/util/gpu/launch-spec";
import { parseHostkeyToken } from "./hostkey-token";
import { gpuSshInfoLocal, registerHostKeyLocal } from "./hostkey";
import { launchGpuPodLocal, terminateGpuPodLocal } from "./pods";
import { lockGpuAccountFence } from "./account-fence";
import { deleteGpuProviderKeyLocal } from "./provider-keys";
import {
  clearHostkeysForCredential,
  clearStaleHostkeyTokens,
} from "./hostkey-clear";
import { upsertExternalCredential } from "@cocalc/server/external-credentials/store";

// The key store, without the site's secret encryption.
jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (_name: string, value: string) => value,
  decryptSecretStorageValue: async (_name: string, value: string) => ({
    value,
  }),
}));

// PGlite in CI; COCALC_TEST_REAL_PG=1 runs the same tests against a real
// PostgreSQL (PGHOST etc.), where the race test really races.
const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ||
  process.env.COCALC_TEST_REAL_PG === "1"
    ? describe
    : describe.skip;

const PROJECT = "00000000-1000-4000-8000-0000000000aa";
const CLIENT_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
// Host keys: two distinct valid ed25519 blobs.
function hostKey(fill: number): string {
  const part = (b: Buffer) => {
    const n = Buffer.alloc(4);
    n.writeUInt32BE(b.length);
    return Buffer.concat([n, b]);
  };
  const blob = Buffer.concat([
    part(Buffer.from("ssh-ed25519")),
    part(Buffer.alloc(32, fill)),
  ]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}
const HOST_KEY = hostKey(1);
const OTHER_KEY = hostKey(2);

function fakeRunpod() {
  const pods = new Map<string, any>();
  const bodies: any[] = [];
  const client = {
    createPod: jest.fn(async (body: any) => {
      bodies.push(body);
      const pod = {
        id: `pod_${randomUUID().slice(0, 8)}`,
        name: body.name,
        status: "RUNNING",
        cost: 0.69,
      };
      pods.set(pod.id, pod);
      return pod;
    }),
    terminatePod: jest.fn(async (id: string) => {
      pods.delete(id);
    }),
    findPodsByName: jest.fn(async (name: string) =>
      [...pods.values()].filter((p) => p.name === name),
    ),
    getPod: jest.fn(async (id: string) =>
      pods.has(id)
        ? {
            ...pods.get(id),
            sshDirect: { host: "203.0.113.7", port: 40022, username: "root" },
          }
        : undefined,
    ),
  };
  return { client, pods, bodies };
}

async function launched() {
  const account_id = randomUUID();
  const rp = fakeRunpod();
  // the account's stored RunPod key, which launches the pod
  const { id: CREDENTIAL } = await upsertExternalCredential({
    selector: {
      provider: "runpod",
      kind: "gpu-provider-api-key",
      scope: "account",
      owner_account_id: account_id,
    },
    payload: "rpa_SYNTHETICKEY0123456789abcdefghijklmnopqrstuv",
  });
  const deps = {
    isHomeBay: async () => true,
    isProjectCollaborator: async () => true,
    getLaunchAccess: async () => ({
      client: rp.client as any,
      credential_id: CREDENTIAL,
    }),
    getCleanup: async () =>
      ({ ...rp.client, credential_id: CREDENTIAL }) as any,
    siteUrl: async () => "https://cocalc.test",
    listPrice: async () => 0.5,
    // the real fence, on the account row it needs (same transaction)
    accountWriteFence: async (db: any, id: string, action: string) => {
      await db.query(
        "INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [id],
      );
      await lockGpuAccountFence(db, id, action);
    },
  };
  const pod = await launchGpuPodLocal(
    {
      account_id,
      project_id: PROJECT,
      spec: {
        gpu_type_id: "NVIDIA GeForce RTX 4090",
        image: GPU_LAUNCH_IMAGES[0],
        max_runtime_minutes: 60,
        ssh_public_key: CLIENT_KEY,
      },
    },
    deps,
  );
  const env = rp.bodies[0].env;
  const token = parseHostkeyToken(env.CC_HOSTKEY_TOKEN)!;
  return { account_id, rp, deps, pod, token, env, credential_id: CREDENTIAL };
}

async function row(id: string) {
  return (await getPool().query("SELECT * FROM gpu_pods WHERE id = $1", [id]))
    .rows[0];
}

async function hostKeyEvents(id: string) {
  return (
    await getPool().query(
      "SELECT actor_kind, details FROM gpu_pod_events WHERE pod_id = $1 AND action = 'host_key' ORDER BY at",
      [id],
    )
  ).rows;
}

// Removing a key drains its pods first (5c), and a finished pod has no token
// or host key left. These tests skip the drain (no pods to wait for): they
// check what the clear at revocation itself guarantees, for any pod a drain
// or a forced removal leaves behind.
// PGlite has one connection, so the account fence (a transaction held
// while the revoke opens its own) is real only on a real PostgreSQL.
const REMOVE_DEPS = {
  isHomeBay: async () => true,
  unfinishedPods: async () => 0,
  credentialPods: async () => [],
  drain: async () => {},
  ...(process.env.COCALC_TEST_REAL_PG === "1"
    ? {}
    : {
        keyFence: async <T>(_account_id: string, fn: (db: any) => Promise<T>) =>
          await fn(getPool()),
      }),
};

describeDb("pod host-key registration", () => {
  beforeAll(async () => {
    await syncSchema({
      gpu_key_fences: SCHEMA.gpu_key_fences,
      gpu_key_events: SCHEMA.gpu_key_events,
      gpu_budget_layers: SCHEMA.gpu_budget_layers,
      gpu_budget_events: SCHEMA.gpu_budget_events,
      gpu_pod_reservations: SCHEMA.gpu_pod_reservations,
      gpu_worker_leases: SCHEMA.gpu_worker_leases,
      gpu_worker_overrides: SCHEMA.gpu_worker_overrides,
      gpu_pods: SCHEMA.gpu_pods,
      gpu_pod_events: SCHEMA.gpu_pod_events,
      external_credentials: SCHEMA.external_credentials,
      accounts: SCHEMA.accounts,
    });
    // a reaper that has just completed a pass (launches need one)
    await getPool().query(
      "INSERT INTO gpu_worker_leases (name, last_completed_at) VALUES ('reaper', now() + interval '10 years') ON CONFLICT (name) DO UPDATE SET last_completed_at = EXCLUDED.last_completed_at",
    );
  });

  it("gives the pod a token, stores only its verifier, and registers the key once", async () => {
    const { pod, token, env, account_id, deps } = await launched();
    expect(env.CC_HOSTKEY_URL).toBe("https://cocalc.test/gpu/pod-host-key");
    const r0 = await row(pod.id);
    expect(r0.hostkey_token_id).toBe(token.token_id);
    expect(JSON.stringify(r0)).not.toContain(token.secret);

    // before registration, sshInfo has no key and isn't ready
    expect(
      await gpuSshInfoLocal({ account_id, pod_id: pod.handle }, deps),
    ).toEqual(expect.objectContaining({ ready: false, state: "running" }));

    const res = await registerHostKeyLocal({
      token,
      pod_id: pod.provider_pod_id!,
      host_public_key: `${HOST_KEY} root@pod`,
    });
    expect(res).toEqual({ status: 200, result: "registered" });
    const r1 = await row(pod.id);
    // canonical, without the comment
    expect(r1.host_public_key).toBe(HOST_KEY);
    expect(r1.host_key_fingerprint).toMatch(/^SHA256:/);
    expect(r1.hostkey_consumed_at).not.toBeNull();
    expect(await hostKeyEvents(pod.id)).toEqual([
      {
        actor_kind: "pod",
        details: {
          provider_pod_id: pod.provider_pod_id,
          host_key_fingerprint: r1.host_key_fingerprint,
        },
      },
    ]);

    const info = await gpuSshInfoLocal({ account_id, pod_id: pod.id }, deps);
    expect(info).toEqual(
      expect.objectContaining({
        ready: true,
        handle: pod.handle,
        host: "203.0.113.7",
        port: 40022,
        user: "root",
        host_public_key: HOST_KEY,
        host_key_fingerprint: r1.host_key_fingerprint,
      }),
    );

    // a replaced key (maybe another RunPod account) gets no endpoint
    const replaced = {
      ...deps,
      getCleanup: async () =>
        ({ ...(await deps.getCleanup()), credential_id: randomUUID() }) as any,
    };
    expect(
      await gpuSshInfoLocal({ account_id, pod_id: pod.id }, replaced),
    ).toEqual(expect.objectContaining({ ready: false, state: "running" }));
  });

  it("answers a retried lost response, and alerts on a different key", async () => {
    const { pod, token } = await launched();
    const report = (host_public_key: string) =>
      registerHostKeyLocal({
        token,
        pod_id: pod.provider_pod_id!,
        host_public_key,
      });
    expect((await report(HOST_KEY)).status).toBe(200);
    expect((await report(HOST_KEY)).status).toBe(200);
    expect(await report(OTHER_KEY)).toEqual({
      status: 409,
      result: "key_mismatch",
    });
    // the registered key is unchanged
    expect((await row(pod.id)).host_public_key).toBe(HOST_KEY);
    expect(
      (await hostKeyEvents(pod.id)).map((e) => e.details.alert ?? "ok"),
    ).toEqual(["ok", "host_key_mismatch"]);
  });

  it("refuses the wrong pod with an alert, before any key is stored", async () => {
    const { pod, token } = await launched();
    expect(
      await registerHostKeyLocal({
        token,
        pod_id: "pod_someoneelse",
        host_public_key: HOST_KEY,
      }),
    ).toEqual({ status: 403, result: "pod_mismatch" });
    expect((await row(pod.id)).host_public_key).toBeNull();
    expect((await hostKeyEvents(pod.id))[0].details.alert).toBe(
      "pod_id_mismatch",
    );
    // the right pod can still register
    expect(
      (
        await registerHostKeyLocal({
          token,
          pod_id: pod.provider_pod_id!,
          host_public_key: HOST_KEY,
        })
      ).status,
    ).toBe(200);
  });

  it("asks the pod to retry until it is bound, and says when it expired", async () => {
    const { pod, token } = await launched();
    await getPool().query(
      "UPDATE gpu_pods SET provider_pod_id = NULL, state = 'creating' WHERE id = $1",
      [pod.id],
    );
    expect(
      await registerHostKeyLocal({
        token,
        pod_id: pod.provider_pod_id!,
        host_public_key: HOST_KEY,
      }),
    ).toEqual({ status: 409, result: "not_bound" });
    await getPool().query(
      "UPDATE gpu_pods SET provider_pod_id = $2, state = 'running', hostkey_expires = now() - interval '1 minute' WHERE id = $1",
      [pod.id, pod.provider_pod_id],
    );
    expect(
      await registerHostKeyLocal({
        token,
        pod_id: pod.provider_pod_id!,
        host_public_key: HOST_KEY,
      }),
    ).toEqual({ status: 410, result: "gone" });
    // long after expiry the token is simply unknown
    await getPool().query(
      "UPDATE gpu_pods SET hostkey_expires = now() - interval '1 hour' WHERE id = $1",
      [pod.id],
    );
    expect(
      (
        await registerHostKeyLocal({
          token,
          pod_id: pod.provider_pod_id!,
          host_public_key: HOST_KEY,
        })
      ).status,
    ).toBe(401);
    expect((await row(pod.id)).hostkey_verifier).toBeNull();
  });

  it("touches only its own row; stale verifiers are cleared apart, without updated", async () => {
    const a = await launched();
    const b = await launched();
    // b's token went stale long ago; its row was last updated a day ago
    await getPool().query(
      "UPDATE gpu_pods SET hostkey_expires = now() - interval '1 hour', updated = now() - interval '1 day' WHERE id = $1",
      [b.pod.id],
    );
    const before = await row(b.pod.id);
    expect(
      (
        await registerHostKeyLocal({
          token: a.token,
          pod_id: a.pod.provider_pod_id!,
          host_public_key: HOST_KEY,
        })
      ).status,
    ).toBe(200);
    // a report on a, or a wrong secret, doesn't sweep b
    await registerHostKeyLocal({
      token: { ...a.token, secret: `${"B".repeat(42)}A` },
      pod_id: a.pod.provider_pod_id!,
      host_public_key: HOST_KEY,
    });
    expect(await row(b.pod.id)).toEqual(before);

    // the periodic cleanup retires b's verifier, and leaves updated alone
    expect(await clearStaleHostkeyTokens()).toBeGreaterThanOrEqual(1);
    const after = await row(b.pod.id);
    expect(after.hostkey_verifier).toBeNull();
    expect(after.hostkey_token_id).toBeNull();
    expect(after.updated).toEqual(before.updated);
    // a's consumed token is still answered within the window
    expect((await row(a.pod.id)).hostkey_verifier).not.toBeNull();
  });

  it("removing the key ends every pending token and registered host key of its pods", async () => {
    const pending = await launched();
    // a second pod of the same account and key, already registered
    const registered = await launched();
    await getPool().query(
      "UPDATE gpu_pods SET key_owner_account_id = $2, beneficiary_account_id = $2, credential_id = $3 WHERE id = $1",
      [registered.pod.id, pending.account_id, pending.credential_id],
    );
    expect(
      (
        await registerHostKeyLocal({
          token: registered.token,
          pod_id: registered.pod.provider_pod_id!,
          host_public_key: HOST_KEY,
        })
      ).status,
    ).toBe(200);

    expect(
      await deleteGpuProviderKeyLocal(
        { account_id: pending.account_id, provider: "runpod" },
        REMOVE_DEPS,
      ),
    ).toEqual({ revoked: true });
    for (const id of [pending.pod.id, registered.pod.id]) {
      const r = await row(id);
      expect(r.hostkey_token_id).toBeNull();
      expect(r.hostkey_verifier).toBeNull();
      expect(r.host_public_key).toBeNull();
      expect(r.host_key_fingerprint).toBeNull();
    }
    expect(
      (
        await registerHostKeyLocal({
          token: pending.token,
          pod_id: pending.pod.provider_pod_id!,
          host_public_key: HOST_KEY,
        })
      ).status,
    ).toBe(401);
    expect(
      await gpuSshInfoLocal(
        { account_id: pending.account_id, pod_id: registered.pod.id },
        registered.deps,
      ),
    ).toEqual(expect.objectContaining({ ready: false }));
  });

  it("revokes the key and clears its pods together, or does neither", async () => {
    const { pod, token, account_id, credential_id } = await launched();
    // the clear fails inside the revoking transaction (a crash would too)
    await expect(
      deleteGpuProviderKeyLocal(
        { account_id, provider: "runpod" },
        {
          ...REMOVE_DEPS,
          clearHostkeys: async (opts, client) => {
            await clearHostkeysForCredential(opts, client);
            throw new Error("boom");
          },
        },
      ),
    ).rejects.toThrow("boom");
    // nothing happened: the key is still active and the token still valid
    const cred = await getPool().query(
      "SELECT revoked, encrypted_payload IS NOT NULL AS has_payload FROM external_credentials WHERE id = $1",
      [credential_id],
    );
    expect(cred.rows[0]).toEqual({ revoked: null, has_payload: true });
    expect((await row(pod.id)).hostkey_verifier).not.toBeNull();
    // so a retry finds the active key and does both
    expect(
      await deleteGpuProviderKeyLocal(
        { account_id, provider: "runpod" },
        REMOVE_DEPS,
      ),
    ).toEqual({ revoked: true });
    expect((await row(pod.id)).hostkey_verifier).toBeNull();
    expect(
      (
        await registerHostKeyLocal({
          token,
          pod_id: pod.provider_pod_id!,
          host_public_key: HOST_KEY,
        })
      ).status,
    ).toBe(401);
  });

  it("refuses a token whose launching key was revoked, even before it is cleared", async () => {
    const { pod, token, credential_id } = await launched();
    // a launch racing the removal: the token row outlives the clear
    await getPool().query(
      "UPDATE external_credentials SET revoked = now() WHERE id = $1",
      [credential_id],
    );
    expect(
      await registerHostKeyLocal({
        token,
        pod_id: pod.provider_pod_id!,
        host_public_key: HOST_KEY,
      }),
    ).toEqual({ status: 410, result: "gone" });
    expect((await row(pod.id)).host_public_key).toBeNull();
  });

  it("reveals nothing to a wrong secret, whatever the pod's state", async () => {
    const { pod, token } = await launched();
    const wrong = { ...token, secret: `${"B".repeat(42)}A` };
    const states = [
      ["fresh", ""],
      [
        "expired",
        "UPDATE gpu_pods SET hostkey_expires = now() - interval '1 minute' WHERE id = $1",
      ],
      [
        "unbound",
        "UPDATE gpu_pods SET provider_pod_id = NULL, state = 'creating', hostkey_expires = now() + interval '1 hour' WHERE id = $1",
      ],
    ];
    for (const [, sql] of states) {
      if (sql) await getPool().query(sql, [pod.id]);
      for (const pod_id of [pod.provider_pod_id!, "pod_someoneelse"]) {
        expect(
          await registerHostKeyLocal({
            token: wrong,
            pod_id,
            host_public_key: HOST_KEY,
          }),
        ).toEqual({ status: 401, result: "unauthorized" });
      }
    }
    // and never raises an alert
    expect(await hostKeyEvents(pod.id)).toEqual([]);
    // an unknown token id is the same
    expect(
      (
        await registerHostKeyLocal({
          token: { ...token, token_id: randomUUID() },
          pod_id: pod.provider_pod_id!,
          host_public_key: HOST_KEY,
        })
      ).status,
    ).toBe(401);
  });

  it("refuses a token for another bay, and a malformed key", async () => {
    const { pod, token } = await launched();
    expect(
      (
        await registerHostKeyLocal({
          token: { ...token, authority_bay_id: "bay-elsewhere" },
          pod_id: pod.provider_pod_id!,
          host_public_key: HOST_KEY,
        })
      ).status,
    ).toBe(401);
    expect(
      await registerHostKeyLocal({
        token,
        pod_id: pod.provider_pod_id!,
        host_public_key: `ssh-ed25519 ${"A".repeat(68)}`,
      }),
    ).toEqual({ status: 400, result: "invalid" });
  });

  it("forgets the token and the host key when the pod is terminated", async () => {
    const { pod, token, account_id, deps } = await launched();
    expect(
      (
        await registerHostKeyLocal({
          token,
          pod_id: pod.provider_pod_id!,
          host_public_key: HOST_KEY,
        })
      ).status,
    ).toBe(200);
    await terminateGpuPodLocal({ account_id, pod_id: pod.id }, deps);
    const r = await row(pod.id);
    expect(r.state).toBe("terminated");
    for (const k of [
      "hostkey_token_id",
      "hostkey_verifier",
      "hostkey_expires",
      "hostkey_consumed_at",
      "host_public_key",
      "host_key_fingerprint",
    ]) {
      expect(r[k]).toBeNull();
    }
    // the audit keeps the fingerprint
    expect(
      (await hostKeyEvents(pod.id))[0].details.host_key_fingerprint,
    ).toMatch(/^SHA256:/);
    expect(
      (
        await registerHostKeyLocal({
          token,
          pod_id: pod.provider_pod_id!,
          host_public_key: HOST_KEY,
        })
      ).status,
    ).toBe(401);
    expect(await gpuSshInfoLocal({ account_id, pod_id: pod.id }, deps)).toEqual(
      expect.objectContaining({ ready: false, state: "terminated" }),
    );
  });

  it("refuses to register once a terminate is requested", async () => {
    const { pod, token } = await launched();
    await getPool().query(
      "UPDATE gpu_pods SET desired_state = 'terminated' WHERE id = $1",
      [pod.id],
    );
    expect(
      (
        await registerHostKeyLocal({
          token,
          pod_id: pod.provider_pod_id!,
          host_public_key: HOST_KEY,
        })
      ).status,
    ).toBe(410);
    expect((await row(pod.id)).host_public_key).toBeNull();
  });

  it("never leaves a terminated pod with a key, whichever of terminate and register wins", async () => {
    for (let i = 0; i < 20; i++) {
      const { pod, token, account_id, deps } = await launched();
      const [reg] = await Promise.all([
        registerHostKeyLocal({
          token,
          pod_id: pod.provider_pod_id!,
          host_public_key: HOST_KEY,
        }),
        terminateGpuPodLocal({ account_id, pod_id: pod.id }, deps),
      ]);
      expect([200, 401, 410]).toContain(reg.status);
      const r = await row(pod.id);
      expect(r.state).toBe("terminated");
      expect(r.host_public_key).toBeNull();
      expect(r.hostkey_verifier).toBeNull();
    }
  });

  it("only shows a pod's SSH info to its own accounts", async () => {
    const { pod, deps } = await launched();
    await expect(
      gpuSshInfoLocal({ account_id: randomUUID(), pod_id: pod.id }, deps),
    ).rejects.toThrow("No such GPU pod.");
  });
});
