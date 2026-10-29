/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Audited decrypts of GPU provider keys (STEP5D2 5d-2c): the capability
// checks, the counted admission, the broker's one-shot permit, the refusal
// on every other decrypting path, the outbox, and outcomes. Needs
// concurrent transactions, hence a real PostgreSQL; skips itself without
// the server binaries.

import { randomUUID } from "node:crypto";
import {
  postgresBinDir,
  startRealPostgres,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";

// the decrypt primitive, instrumented (encryption is the identity)
const decrypts = jest.fn();
jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (_name: string, value: string) => value,
  decryptSecretStorageValue: async (_name: string, value: string) => {
    decrypts(value);
    return { value };
  },
}));

const describeRealPostgres = postgresBinDir() ? describe : describe.skip;

jest.setTimeout(30_000);

const KEY = "rpa_AUDITKEY0123456789abcdefghijklmnopqrstuvwxyz";

describeRealPostgres("audited GPU key decrypts", () => {
  let pg: RealPostgres;
  let getPool: any;
  let ku: typeof import("./key-use");
  let store: typeof import("@cocalc/server/external-credentials/store");
  let reaper: typeof import("./reaper");

  beforeAll(async () => {
    pg = startRealPostgres("gpu_key_use_test");
    getPool = (await import("@cocalc/database/pool")).default;
    const { SCHEMA } = await import("@cocalc/util/db-schema");
    const { syncSchema } =
      await import("@cocalc/database/postgres/schema/sync");
    await syncSchema({
      external_credentials: SCHEMA.external_credentials,
      gpu_key_uses: SCHEMA.gpu_key_uses,
      gpu_key_use_outcomes: SCHEMA.gpu_key_use_outcomes,
      gpu_key_decrypts: SCHEMA.gpu_key_decrypts,
      security_event_outbox: SCHEMA.security_event_outbox,
      gpu_worker_leases: SCHEMA.gpu_worker_leases,
      gpu_worker_runs: SCHEMA.gpu_worker_runs,
    });
    ku = await import("./key-use");
    store = await import("@cocalc/server/external-credentials/store");
    reaper = await import("./reaper");
  }, 120_000);

  afterAll(async () => {
    try {
      await getPool?.().end();
    } finally {
      pg?.stop();
    }
  });

  beforeEach(() => decrypts.mockReset());

  const selector = (account_id: string) => ({
    provider: "runpod",
    kind: "gpu-provider-api-key",
    scope: "account" as const,
    owner_account_id: account_id,
  });

  async function owner() {
    const account_id = randomUUID();
    const { id } = await store.upsertExternalCredential({
      selector: selector(account_id),
      payload: KEY,
      metadata: {},
    });
    return { account_id, credential_id: id };
  }

  const admitted = async (where: string, args: unknown[]) =>
    (
      await getPool().query(
        `SELECT count(*)::int AS n FROM gpu_key_decrypts WHERE ${where}`,
        args,
      )
    ).rows[0].n;

  describe("the broker", () => {
    it("refuses this kind on every other decrypting path, before the primitive", async () => {
      const o = await owner();
      const calls: Array<[string, () => Promise<unknown>]> = [
        [
          "getExternalCredential",
          () =>
            store.getExternalCredential({ selector: selector(o.account_id) }),
        ],
        [
          "getExternalCredentialById",
          () =>
            store.getExternalCredentialById({
              id: o.credential_id,
              selector: selector(o.account_id),
            }),
        ],
        [
          "updateExternalCredentialPayloadLocked",
          () =>
            store.updateExternalCredentialPayloadLocked({
              selector: selector(o.account_id),
              id: o.credential_id,
              update: async () => undefined,
            }),
        ],
        [
          "updateExternalCredentialById",
          () =>
            store.updateExternalCredentialById({
              id: o.credential_id,
              selector: selector(o.account_id),
              payload: "rpa_other",
              metadata: {},
              expectedPayloadSha256: "0".repeat(64),
            }),
        ],
      ];
      // every export of the store that can return or compare a payload
      const decrypting = Object.keys(store)
        .filter((k) => typeof (store as any)[k] === "function")
        .filter(
          (k) =>
            /^(get|update)ExternalCredential/.test(k) &&
            !/Label|MetadataValue/.test(k),
        )
        .sort();
      expect(decrypting).toEqual(calls.map(([name]) => name).sort());
      for (const [name, call] of calls) {
        await expect(call()).rejects.toThrow(store.GPU_KEY_REFUSED);
        expect([name, decrypts.mock.calls.length]).toEqual([name, 0]);
      }
    });

    it("gives the key once per admitted decrypt: a repeated or concurrent use gets nothing", async () => {
      const o = await owner();
      const use = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "pod_read",
      });
      const id = await ku.admitDecrypt(use, o);
      const got: string[] = [];
      const results = await Promise.allSettled([
        store.withAuditedGpuKey(id, o.credential_id, async (k) => {
          got.push(k);
        }),
        store.withAuditedGpuKey(id, o.credential_id, async (k) => {
          got.push(k);
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect(got).toEqual([KEY]);
      expect(decrypts).toHaveBeenCalledTimes(1);
      // and again, later
      await expect(
        store.withAuditedGpuKey(id, o.credential_id, async () => {}),
      ).rejects.toThrow("already used");
      expect(decrypts).toHaveBeenCalledTimes(1);
      const { rows } = await getPool().query(
        "SELECT claimed_at, finished, outcome FROM gpu_key_decrypts WHERE id = $1",
        [id],
      );
      expect(rows[0].claimed_at).not.toBeNull();
      expect(rows[0].finished).not.toBeNull();
      expect(rows[0].outcome).toBe("ok");
    });

    it("never reuses a permit claimed by a call that crashed before decrypting", async () => {
      const o = await owner();
      const use = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "ssh_info",
      });
      const id = await ku.admitDecrypt(use, o);
      // the claim committed, then the process died
      await getPool().query(
        "UPDATE gpu_key_decrypts SET claimed_at = now(), claim_nonce = 'dead' WHERE id = $1",
        [id],
      );
      await expect(
        store.withAuditedGpuKey(id, o.credential_id, async () => {}),
      ).rejects.toThrow("already used");
      expect(decrypts).not.toHaveBeenCalled();
      const { rows } = await getPool().query(
        "SELECT finished FROM gpu_key_decrypts WHERE id = $1",
        [id],
      );
      // claimed and unfinished: the audit's decrypt_unresolved
      expect(rows[0].finished).toBeNull();
    });

    it("records a failure inside the callback as how the decrypt finished", async () => {
      const o = await owner();
      const use = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "pod_read",
      });
      const id = await ku.admitDecrypt(use, o);
      await expect(
        store.withAuditedGpuKey(id, o.credential_id, async () => {
          throw Error("boom");
        }),
      ).rejects.toThrow("boom");
      const { rows } = await getPool().query(
        "SELECT outcome FROM gpu_key_decrypts WHERE id = $1",
        [id],
      );
      expect(rows[0].outcome).toBe("error");
    });
  });

  describe("admission", () => {
    it("admits a record for its owner, purpose and key, and writes the decrypt and its outbox row together", async () => {
      const o = await owner();
      const use = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "launch",
      });
      const id = await ku.admitDecrypt(use, o);
      const { rows } = await getPool().query(
        "SELECT key_use_id, purpose, principal, credential_id FROM gpu_key_decrypts WHERE id = $1",
        [id],
      );
      expect(rows[0]).toEqual({
        key_use_id: use.id,
        purpose: "launch",
        principal: o.account_id,
        credential_id: o.credential_id,
      });
      const { rows: out } = await getPool().query(
        "SELECT kind, details FROM security_event_outbox WHERE details->>'id' = $1",
        [id],
      );
      expect(out).toHaveLength(1);
      expect(out[0].kind).toBe("gpu_key_decrypt");
      expect(out[0].details).toMatchObject({
        purpose: "launch",
        key_use_id: use.id,
      });
      // the record's counter, under its limit (1 for a write)
      await expect(ku.admitDecrypt(use, o)).rejects.toThrow(ku.KeyUseRefused);
    });

    it("admits exactly one of two concurrent decrypts at the limit", async () => {
      const o = await owner();
      const use = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "terminate",
      });
      const results = await Promise.allSettled([
        ku.admitDecrypt(use, o),
        ku.admitDecrypt(use, o),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await admitted("key_use_id = $1", [use.id])).toBe(1);
      const { rows } = await getPool().query(
        "SELECT decrypts FROM gpu_key_uses WHERE id = $1",
        [use.id],
      );
      expect(rows[0].decrypts).toBe(1);
    });

    it("refuses, writing nothing and never reaching the primitive: a forged, wire-carried, wrong-owner, wrong-key, wrong-purpose or expired capability", async () => {
      const o = await owner();
      const other = await owner();
      const use = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "pod_read",
      });
      const refused = async (cap: unknown, key: typeof o) => {
        await expect(ku.admitDecrypt(cap, key)).rejects.toThrow(
          ku.KeyUseRefused,
        );
      };
      // put together by hand, or as it would arrive over a wire
      await refused({ ...use }, o);
      await refused(JSON.parse(JSON.stringify(use)), o);
      await refused(undefined, o);
      // another owner's key, or another key of this owner
      await refused(use, other);
      await refused(use, { ...o, credential_id: other.credential_id });
      // a record of another purpose (the purpose is the record's)
      const read = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "ssh_info",
      });
      await getPool().query(
        "UPDATE gpu_key_uses SET purpose = 'launch' WHERE id = $1",
        [read.id],
      );
      await refused(read, o);
      // expired
      const late = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "pod_read",
      });
      await getPool().query(
        "UPDATE gpu_key_uses SET expires = now() - interval '1 second' WHERE id = $1",
        [late.id],
      );
      await refused(late, o);
      expect(
        await admitted("key_owner_account_id = ANY($1)", [
          [o.account_id, other.account_id],
        ]),
      ).toBe(0);
      expect(decrypts).not.toHaveBeenCalled();
    });

    it("lets a connect's verify read only the key its own store bound it to, once", async () => {
      const o = await owner();
      const verify = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "verify",
      });
      // unbound: no key at all
      await expect(ku.admitDecrypt(verify, o)).rejects.toThrow(
        ku.KeyUseRefused,
      );
      await ku.bindVerifyUse(getPool(), verify, o);
      // bound once: never again, to anything
      const other = await owner();
      await expect(
        ku.bindVerifyUse(getPool(), verify, {
          account_id: o.account_id,
          credential_id: other.credential_id,
        }),
      ).rejects.toThrow(ku.KeyUseRefused);
      expect(await ku.admitDecrypt(verify, o)).toBeTruthy();
    });

    it("admits a worker's decrypt only while its named run is open and holds the lease", async () => {
      const o = await owner();
      const token = `t-${randomUUID()}`;
      const now = new Date();
      expect(await reaper.acquireWorkerLease("billing", token, now)).toBe(true);
      const cap = ku.workerKeyUse("billing", token, "billing");
      const id = await ku.admitDecrypt(cap, o);
      const { rows } = await getPool().query(
        "SELECT worker_run_id, worker_name, principal FROM gpu_worker_runs r JOIN gpu_key_decrypts d ON d.worker_run_id = r.id WHERE d.id = $1",
        [id],
      );
      expect(rows[0]).toMatchObject({
        worker_name: "billing",
        principal: "worker:billing",
      });
      // another worker's name with this token, or a purpose not its own
      await expect(
        ku.admitDecrypt(ku.workerKeyUse("reaper", token, "reaper"), o),
      ).rejects.toThrow(ku.KeyUseRefused);
      expect(() => ku.workerKeyUse("billing", token, "reconcile")).toThrow();
      // the lease expired (not yet taken over): refused
      await getPool().query(
        "UPDATE gpu_worker_leases SET expires_at = now() - interval '1 second' WHERE name = 'billing'",
      );
      await expect(ku.admitDecrypt(cap, o)).rejects.toThrow(ku.KeyUseRefused);
      // a new holder: the old run is closed, and stays refused
      const next = `t-${randomUUID()}`;
      expect(await reaper.acquireWorkerLease("billing", next, new Date())).toBe(
        true,
      );
      await expect(ku.admitDecrypt(cap, o)).rejects.toThrow(ku.KeyUseRefused);
      expect(
        await ku.admitDecrypt(ku.workerKeyUse("billing", next, "billing"), o),
      ).toBeTruthy();
      await reaper.finishWorkerLease("billing", next, new Date());
    });

    it("commits the account checks' own decrypt in the reconciler's run, through the key helper", async () => {
      const o = await owner();
      const token = `t-${randomUUID()}`;
      expect(
        await reaper.acquireWorkerLease("reconciler", token, new Date()),
      ).toBe(true);
      try {
        const run = ku.workerKeyUse("reconciler", token, "reconcile");
        const keys = await import("./provider-keys");
        // the reconcile pass's decrypt, and nested in it the account
        // checks' own (as reconcileKey opens them)
        const seen = await keys.withRunpodCleanup(
          o.account_id,
          run,
          { isHomeBay: async () => true },
          async (c) =>
            await keys.withRunpodCleanup(
              o.account_id,
              ku.workerKeyUseFor(run, "account_watch"),
              { isHomeBay: async () => true },
              async (w) => [c?.credential_id, w?.credential_id],
            ),
        );
        expect(seen).toEqual([o.credential_id, o.credential_id]);
        const { rows } = await getPool().query(
          `SELECT d.purpose, d.outcome, d.worker_name FROM gpu_key_decrypts d
             JOIN gpu_worker_runs r ON r.id = d.worker_run_id
            WHERE r.token = $1 ORDER BY d.started`,
          [token],
        );
        expect(rows).toEqual([
          { purpose: "reconcile", outcome: "ok", worker_name: "reconciler" },
          {
            purpose: "account_watch",
            outcome: "ok",
            worker_name: "reconciler",
          },
        ]);
      } finally {
        await reaper.finishWorkerLease("reconciler", token, new Date());
      }
    });

    it("keeps key material out of every audit row", async () => {
      const o = await owner();
      const use = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "pod_read",
      });
      const id = await ku.admitDecrypt(use, o);
      await store.withAuditedGpuKey(id, o.credential_id, async () => {});
      for (const table of [
        "gpu_key_uses",
        "gpu_key_decrypts",
        "security_event_outbox",
      ]) {
        const { rows } = await getPool().query(
          `SELECT row_to_json(t)::text AS j FROM ${table} t`,
        );
        for (const { j } of rows) {
          expect(j).not.toContain(KEY);
          expect(j).not.toMatch(/rpa_[A-Za-z0-9]{8,}/);
        }
      }
    });
  });

  describe("outcomes", () => {
    it("records a write's outcome once, whatever happened; a read records none", async () => {
      const o = await owner();
      const outcome = async (id: string) =>
        (
          await getPool().query(
            "SELECT outcome FROM gpu_key_use_outcomes WHERE key_use_id = $1",
            [id],
          )
        ).rows[0]?.outcome;
      const ok = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "launch",
      });
      await ku.withKeyUseOutcome(ok, async () => 1);
      expect(await outcome(ok.id)).toBe("succeeded");
      const failed = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "terminate",
      });
      await expect(
        ku.withKeyUseOutcome(failed, async () => {
          throw Error("refused");
        }),
      ).rejects.toThrow();
      expect(await outcome(failed.id)).toBe("failed");
      const { RunpodApiError } = await import("@cocalc/cloud/runpod/client");
      const unknown = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "removal",
      });
      await expect(
        ku.withKeyUseOutcome(unknown, async () => {
          throw new RunpodApiError("network");
        }),
      ).rejects.toThrow();
      expect(await outcome(unknown.id)).toBe("unknown");
      // immutable: a second record of the same use changes nothing
      await ku.withKeyUseOutcome(failed, async () => 1);
      expect(await outcome(failed.id)).toBe("failed");
      const read = await ku.admitUserKeyUse({
        account_id: o.account_id,
        purpose: "pod_read",
      });
      await ku.withKeyUseOutcome(read, async () => 1);
      expect(await outcome(read.id)).toBeUndefined();
    });
  });
});
