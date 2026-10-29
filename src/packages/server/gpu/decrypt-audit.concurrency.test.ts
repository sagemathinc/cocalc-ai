/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The decrypt audit (STEP5D2 5d-2c-2) against a real PostgreSQL: every
// maturity class, every verdict, its alerts, and retention. Skips itself
// without the server binaries.

import { randomUUID } from "node:crypto";
import {
  postgresBinDir,
  startRealPostgres,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (_name: string, value: string) => value,
  decryptSecretStorageValue: async (_name: string, value: string) => ({
    value,
  }),
}));

const describeRealPostgres = postgresBinDir() ? describe : describe.skip;

jest.setTimeout(30_000);

const KEY = "rpa_AUDITTESTKEY0123456789abcdefghijklmnopqrstu";
const HOUR = 3_600_000;

describeRealPostgres("the GPU decrypt audit", () => {
  let pg: RealPostgres;
  let getPool: any;
  let ku: typeof import("./key-use");
  let store: typeof import("@cocalc/server/external-credentials/store");
  let reaper: typeof import("./reaper");
  let audit: typeof import("./decrypt-audit");
  let bay: string;

  beforeAll(async () => {
    pg = startRealPostgres("gpu_decrypt_audit_test");
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
      gpu_admin_alerts: SCHEMA.gpu_admin_alerts,
      gpu_alerts: SCHEMA.gpu_alerts,
      gpu_provider_account_watch: SCHEMA.gpu_provider_account_watch,
    });
    ku = await import("./key-use");
    store = await import("@cocalc/server/external-credentials/store");
    reaper = await import("./reaper");
    audit = await import("./decrypt-audit");
    bay = (await import("@cocalc/server/bay-config")).getConfiguredBayId();
  }, 120_000);

  afterAll(async () => {
    try {
      await getPool?.().end();
    } finally {
      pg?.stop();
    }
  });

  const q = (sql: string, args: unknown[] = []) => getPool().query(sql, args);

  async function owner() {
    const account_id = randomUUID();
    const { id } = await store.upsertExternalCredential({
      selector: {
        provider: "runpod",
        kind: "gpu-provider-api-key",
        scope: "account",
        owner_account_id: account_id,
      },
      payload: KEY,
      metadata: {},
    });
    return { account_id, credential_id: id };
  }

  // a person's action that read the key (or only got admitted)
  async function userDecrypt(
    o: { account_id: string; credential_id: string },
    purpose: any,
    { read = true, fail = false } = {},
  ) {
    const use = await ku.admitUserKeyUse({ account_id: o.account_id, purpose });
    const id = await ku.admitDecrypt(use, o);
    if (read) {
      await store
        .withAuditedGpuKey(id, o.credential_id, async () => {
          if (fail) throw Error("RunPod refused");
        })
        .catch(() => {});
    }
    return { use, id };
  }

  // the audit, at `now` (default: well after every record expired), with
  // every owner homed here
  const run = (now = Date.now() + HOUR) =>
    audit.auditDecrypts(
      { now: () => now, homeBayOf: async () => bay },
      async () => {},
    );

  const verdict = async (id: string) =>
    (
      await q(
        "SELECT verdict, audited_at FROM gpu_key_decrypts WHERE id = $1",
        [id],
      )
    ).rows[0];

  const adminAlert = async (credential_id: string, kind: string) =>
    (
      await q(
        "SELECT severity, details FROM gpu_admin_alerts WHERE credential_id = $1 AND kind = $2 AND resolved_at IS NULL",
        [credential_id, kind],
      )
    ).rows[0];

  const ownerAlert = async (credential_id: string) =>
    (
      await q(
        "SELECT severity FROM gpu_alerts WHERE credential_id = $1 AND kind = 'unexplained_decrypt' AND resolved_at IS NULL",
        [credential_id],
      )
    ).rows[0];

  it("explains a valid read once its record expired, and not before", async () => {
    const o = await owner();
    const { id } = await userDecrypt(o, "pod_read");
    // in flight: its record hasn't expired
    await run(Date.now());
    expect((await verdict(id)).audited_at).toBeNull();
    await run();
    expect(await verdict(id)).toMatchObject({ verdict: "explained" });
    expect(await adminAlert(o.credential_id, "unexplained_decrypt")).toBe(
      undefined,
    );
  });

  it("explains a write as soon as its outcome is recorded, whatever the outcome", async () => {
    const o = await owner();
    for (const outcome of ["succeeded", "failed", "unknown"]) {
      const { use, id } = await userDecrypt(o, "terminate");
      await q(
        "INSERT INTO gpu_key_use_outcomes (key_use_id, outcome, at) VALUES ($1, $2, now())",
        [use.id, outcome],
      );
      // before its record expired: an outcome is enough
      await run(Date.now());
      expect([outcome, await verdict(id)]).toMatchObject([
        outcome,
        { verdict: "explained" },
      ]);
    }
  });

  it("reports a write with no outcome once its record expired (a crash): unresolved, never critical", async () => {
    const o = await owner();
    const { id } = await userDecrypt(o, "launch");
    await run(Date.now());
    expect((await verdict(id)).audited_at).toBeNull();
    await run();
    expect(await verdict(id)).toMatchObject({ verdict: "unresolved" });
    expect(await adminAlert(o.credential_id, "decrypt_unresolved")).toEqual({
      severity: "warning",
      details: expect.objectContaining({ decrypt_id: id, purpose: "launch" }),
    });
    expect(await adminAlert(o.credential_id, "unexplained_decrypt")).toBe(
      undefined,
    );
    expect(await ownerAlert(o.credential_id)).toBe(undefined);
  });

  it("reports a read the broker claimed but never finished as unresolved", async () => {
    const o = await owner();
    const { id } = await userDecrypt(o, "ssh_info", { read: false });
    await q(
      "UPDATE gpu_key_decrypts SET claimed_at = now(), claim_nonce = 'dead' WHERE id = $1",
      [id],
    );
    await run();
    expect(await verdict(id)).toMatchObject({ verdict: "unresolved" });
  });

  it("records an admission whose key was never read as unused, with no alert", async () => {
    const o = await owner();
    const { id } = await userDecrypt(o, "pod_read", { read: false });
    await run();
    expect(await verdict(id)).toMatchObject({ verdict: "admitted_unused" });
    expect(await adminAlert(o.credential_id, "decrypt_unresolved")).toBe(
      undefined,
    );
  });

  it("judges a missing, forged or mismatched capability at once: critical for admins, a warning for the owner", async () => {
    const o = await owner();
    const forged = async (fields: Record<string, unknown>) => {
      const id = randomUUID();
      const row = {
        key_use_id: null,
        worker_run_id: null,
        worker_name: null,
        purpose: "launch",
        principal: o.account_id,
        bay_id: bay,
        ...fields,
      };
      await q(
        `INSERT INTO gpu_key_decrypts (id, key_use_id, worker_run_id, worker_name,
           purpose, key_owner_account_id, credential_id, principal, bay_id,
           process, started, claimed_at, finished, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'test', now(), now(), now(), 'ok')`,
        [
          id,
          row.key_use_id,
          row.worker_run_id,
          row.worker_name,
          row.purpose,
          o.account_id,
          o.credential_id,
          row.principal,
          row.bay_id,
        ],
      );
      return id;
    };
    const valid = await ku.admitUserKeyUse({
      account_id: o.account_id,
      purpose: "pod_read",
    });
    const cases = [
      await forged({}), // no capability at all
      await forged({ key_use_id: "f".repeat(32) }), // no such record
      await forged({ key_use_id: valid.id }), // another purpose
      await forged({
        key_use_id: valid.id,
        purpose: "pod_read",
        principal: "someone-else",
      }),
      await forged({
        key_use_id: valid.id,
        purpose: "pod_read",
        bay_id: "another-bay",
      }),
      await forged({
        worker_run_id: randomUUID(),
        worker_name: "billing",
        purpose: "billing",
      }),
    ];
    // judged now, with nothing to wait for
    await run(Date.now());
    for (const id of cases) {
      expect(await verdict(id)).toMatchObject({ verdict: "unexplained" });
    }
    expect(await adminAlert(o.credential_id, "unexplained_decrypt")).toEqual({
      severity: "critical",
      details: expect.objectContaining({ why: expect.any(String) }),
    });
    expect(await ownerAlert(o.credential_id)).toEqual({ severity: "warning" });
    expect(
      (await adminAlert(o.credential_id, "unexplained_decrypt")).details,
    ).toMatchObject({ owner_notified: true });
  });

  it("flags a record used past its limit", async () => {
    const o = await owner();
    const { use } = await userDecrypt(o, "launch");
    // a second decrypt row on a one-decrypt record (no admission allows it)
    await q(
      `INSERT INTO gpu_key_decrypts (id, key_use_id, purpose, key_owner_account_id,
         credential_id, principal, bay_id, process, started, claimed_at, finished, outcome)
       VALUES ($1, $2, 'launch', $3, $4, $6, $5, 'test', now(), now(), now(), 'ok')`,
      [randomUUID(), use.id, o.account_id, o.credential_id, bay, o.account_id],
    );
    await run(Date.now());
    const { rows } = await q(
      "SELECT verdict FROM gpu_key_decrypts WHERE key_use_id = $1",
      [use.id],
    );
    expect(rows.map((r: any) => r.verdict)).toEqual([
      "unexplained",
      "unexplained",
    ]);
  });

  it("judges a worker's decrypt only after its run closed, against when it held the lease", async () => {
    const o = await owner();
    const token = `t-${randomUUID()}`;
    expect(await reaper.acquireWorkerLease("billing", token, new Date())).toBe(
      true,
    );
    const cap = ku.workerKeyUse("billing", token, "billing");
    const read = await ku.admitDecrypt(cap, o);
    await store.withAuditedGpuKey(read, o.credential_id, async () => {});
    const crashed = await ku.admitDecrypt(cap, o);
    await q(
      "UPDATE gpu_key_decrypts SET claimed_at = now(), claim_nonce = 'dead' WHERE id = $1",
      [crashed],
    );
    const unused = await ku.admitDecrypt(cap, o);
    // the run is open and holds its lease: nothing judged
    await run(Date.now());
    expect((await verdict(read)).audited_at).toBeNull();
    await reaper.finishWorkerLease("billing", token, new Date());
    // closed, but within the grace period
    await run(Date.now());
    expect((await verdict(read)).audited_at).toBeNull();
    await run();
    expect(await verdict(read)).toMatchObject({ verdict: "explained" });
    expect(await verdict(crashed)).toMatchObject({ verdict: "unresolved" });
    expect(await verdict(unused)).toMatchObject({
      verdict: "admitted_unused",
    });
    // a decrypt dated outside its run's lease
    const outside = randomUUID();
    const { rows } = await q(
      "SELECT id FROM gpu_worker_runs WHERE token = $1",
      [token],
    );
    await q(
      `INSERT INTO gpu_key_decrypts (id, worker_run_id, worker_name, purpose,
         key_owner_account_id, credential_id, principal, bay_id, process, started,
         claimed_at, finished, outcome)
       VALUES ($1, $2, 'billing', 'billing', $3, $4, 'worker:billing', $5, 'test',
         now() + interval '1 day', now(), now(), 'ok')`,
      [outside, rows[0].id, o.account_id, o.credential_id, bay],
    );
    await run(Date.now() + 2 * 24 * HOUR);
    expect(await verdict(outside)).toMatchObject({ verdict: "unexplained" });
  });

  it("judges a decrypt that started at or after its exact record's expiry as unexplained, at once", async () => {
    const o = await owner();
    for (const after of ["0 milliseconds", "1 millisecond"]) {
      const { use, id } = await userDecrypt(o, "pod_read");
      // dated at (or just after) the expiry of the record it presents
      await q(
        `UPDATE gpu_key_decrypts SET started = (SELECT expires FROM gpu_key_uses WHERE id = $2) + interval '${after}' WHERE id = $1`,
        [id, use.id],
      );
      await run(Date.now());
      expect([after, await verdict(id)]).toMatchObject([
        after,
        { verdict: "unexplained" },
      ]);
    }
  });

  it("ends a lost run's authority at its lease's expiry, not when the loss was noticed", async () => {
    const o = await owner();
    const token = `t-${randomUUID()}`;
    const t0 = new Date(Date.now() - 10 * 60_000);
    // taken ten minutes ago with a one-minute lease, never renewed
    expect(await reaper.acquireWorkerLease("billing", token, t0, 60_000)).toBe(
      true,
    );
    const { rows } = await q(
      "SELECT id, lease_expires_at FROM gpu_worker_runs WHERE token = $1",
      [token],
    );
    const run_id = rows[0].id;
    const inside = randomUUID();
    const after = randomUUID();
    const insert = (id: string, at: string) =>
      q(
        `INSERT INTO gpu_key_decrypts (id, worker_run_id, worker_name, purpose,
           key_owner_account_id, credential_id, principal, bay_id, process, started,
           claimed_at, finished, outcome)
         VALUES ($1, $2, 'billing', 'billing', $3, $4, 'worker:billing', $5, 'test',
           ${at}, now(), now(), 'ok')`,
        [id, run_id, o.account_id, o.credential_id, bay],
      );
    await insert(
      inside,
      "$6::timestamptz + interval '30 seconds'".replace(
        "$6",
        `'${t0.toISOString()}'`,
      ),
    );
    // after the lease expired, before another holder noticed
    await insert(
      after,
      `'${new Date(t0.getTime() + 3 * 60_000).toISOString()}'`,
    );
    // another holder takes over now: the old run closes as lost, now
    expect(
      await reaper.acquireWorkerLease(
        "billing",
        `t-${randomUUID()}`,
        new Date(),
      ),
    ).toBe(true);
    await run();
    expect(await verdict(inside)).toMatchObject({ verdict: "explained" });
    expect(await verdict(after)).toMatchObject({ verdict: "unexplained" });
  });

  it("refuses to judge the home bay away: a decrypt on a bay that isn't the owner's home is unexplained", async () => {
    const o = await owner();
    const { id } = await userDecrypt(o, "pod_read");
    await audit.auditDecrypts(
      {
        now: () => Date.now() + HOUR,
        homeBayOf: async () => "another-bay",
      },
      async () => {},
    );
    expect(await verdict(id)).toMatchObject({ verdict: "unexplained" });
    // the owner reads alerts on their home bay: none is written here, and
    // the admins' alert says so
    expect(await ownerAlert(o.credential_id)).toBe(undefined);
    expect(await adminAlert(o.credential_id, "unexplained_decrypt")).toEqual({
      severity: "critical",
      details: expect.objectContaining({ owner_notified: false }),
    });
  });

  it("leaves a decrypt pending while the owner's home bay can't be looked up", async () => {
    const o = await owner();
    const { id } = await userDecrypt(o, "pod_read");
    const out = await audit.auditDecrypts(
      {
        now: () => Date.now() + HOUR,
        homeBayOf: async () => {
          throw Error("bay directory unavailable");
        },
      },
      async () => {},
    );
    expect(out.pending).toBeGreaterThan(0);
    expect((await verdict(id)).audited_at).toBeNull();
    // judged by the next pass that can look it up
    await run();
    expect(await verdict(id)).toMatchObject({ verdict: "explained" });
  });

  it("keeps key material out of its alerts", async () => {
    const { rows } = await q(
      `SELECT row_to_json(a)::text AS j FROM gpu_admin_alerts a
       UNION ALL SELECT row_to_json(b)::text FROM gpu_alerts b`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const { j } of rows) {
      expect(j).not.toContain(KEY);
      expect(j).not.toMatch(/rpa_[A-Za-z0-9]{8,}/);
    }
  });

  it("deletes only audited rows past retention, and outbox rows once acked or old", async () => {
    const o = await owner();
    const old = await userDecrypt(o, "pod_read");
    const fresh = await userDecrypt(o, "pod_read");
    const unaudited = await userDecrypt(o, "pod_read");
    await run();
    // everything a retention period ago (the unaudited one too, unjudged)
    const past = "now() - interval '91 days'";
    for (const d of [old, unaudited]) {
      await q(
        `UPDATE gpu_key_uses SET created = ${past}, expires = ${past} WHERE id = $1`,
        [d.use.id],
      );
      await q(`UPDATE gpu_key_decrypts SET started = ${past} WHERE id = $1`, [
        d.id,
      ]);
    }
    await q(
      "UPDATE gpu_key_decrypts SET audited_at = NULL, verdict = NULL WHERE id = $1",
      [unaudited.id],
    );
    await q("UPDATE gpu_key_uses SET audited_at = NULL WHERE id = $1", [
      unaudited.use.id,
    ]);
    const acked = randomUUID();
    const oldOutbox = randomUUID();
    const kept = randomUUID();
    await q(
      `INSERT INTO security_event_outbox (id, kind, details, created, acked_at) VALUES
         ($1, 't', '{}', now(), now()),
         ($2, 't', '{}', now() - interval '91 days', NULL),
         ($3, 't', '{}', now(), NULL)`,
      [acked, oldOutbox, kept],
    );
    await audit.retain(Date.now());
    const exists = async (table: string, id: string) =>
      (await q(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rows.length > 0;
    expect(await exists("gpu_key_decrypts", old.id)).toBe(false);
    expect(await exists("gpu_key_uses", old.use.id)).toBe(false);
    expect(await exists("gpu_key_decrypts", fresh.id)).toBe(true);
    expect(await exists("gpu_key_decrypts", unaudited.id)).toBe(true);
    expect(await exists("gpu_key_uses", unaudited.use.id)).toBe(true);
    expect(await exists("security_event_outbox", acked)).toBe(false);
    expect(await exists("security_event_outbox", oldOutbox)).toBe(false);
    expect(await exists("security_event_outbox", kept)).toBe(true);
  });

  it("runs as a worker of its own, one sweep at a time", async () => {
    const results = await Promise.all([
      audit.runDecryptAuditSweep({ homeBayOf: async () => bay }),
      audit.runDecryptAuditSweep({ homeBayOf: async () => bay }),
    ]);
    expect(results.map((r) => r.ran).sort()).toEqual([false, true]);
    const { rows } = await q(
      "SELECT outcome FROM gpu_worker_runs WHERE name = 'decrypt_audit'",
    );
    expect(rows.map((r: any) => r.outcome)).toEqual(["finished"]);
  });
});
