/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The provider-account checks (5d-2b) against a real (PGlite) database and a
// fake RunPod balance: off without the owner's confirmation and with a
// second key on the same account; the spend rate over 2 consecutive passes;
// the balance over a 30-minute window, a deposit starting it over; E from
// the state ledger (stopped time is disk only); stale samples; the pause,
// the owner's resume and withdrawal; and the reconcile pass calling it.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { lockGpuAccountFence } from "./account-fence";
import {
  confirmAccountChecksLocal,
  expectedRate,
  expectedSpend,
  getAccountChecksLocal,
  watchProviderAccount,
} from "./account-watch";
import { resumeGpuLaunchesLocal } from "./budget-api";
import { listAlertsLocal, onKeyGone, raiseAlert } from "./alerts";
import { reportCompromisedLocal } from "./compromise";
import { inTransaction } from "./pods";
import { reconcileKey } from "./reconcile";
import { RunpodApiError } from "@cocalc/cloud/runpod/client";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = new Date("2026-10-28T00:00:00Z").getTime();
const at = (ms: number) => new Date(T0 + ms);

const here = { isHomeBay: async () => true };
const accountWriteFence = async (db: any, id: string, action: string) => {
  await db.query(
    "INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [id],
  );
  await lockGpuAccountFence(db, id, action);
};

// A connected key (a live fence) on the RunPod account `identity`.
async function connectKey(owner: string, identity: string): Promise<string> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO external_credentials (id, provider, kind, scope, owner_account_id,
       encrypted_payload, metadata, created, updated)
     VALUES ($1, 'runpod', 'gpu-provider-api-key', 'account', $2, 'x', $3, now(), now())`,
    [
      id,
      owner,
      { provider_account_kind: "personal", provider_account_id: identity },
    ],
  );
  await getPool().query(
    `INSERT INTO gpu_key_fences (credential_id, key_owner_account_id, state, created, updated)
     VALUES ($1, $2, 'active', now(), now())`,
    [id, owner],
  );
  return id;
}

async function revoke(credential_id: string) {
  await getPool().query(
    "UPDATE external_credentials SET revoked = now() WHERE id = $1",
    [credential_id],
  );
}

// a valid pod handle (base32, lower case)
function handle(): string {
  const a = "abcdefghijklmnopqrstuvwxyz234567";
  return `cc-${Array.from({ length: 16 }, () => a[Math.floor(Math.random() * 32)]).join("")}`;
}

// A pod of the key in `state`, with its ledger: [state, from, to] (ms from
// T0; to undefined: open).
async function pod(
  owner: string,
  credential_id: string,
  {
    state,
    cost_per_hr,
    intervals,
    terminated_at,
  }: {
    state: string;
    cost_per_hr: number;
    intervals: [string, number, number | undefined][];
    terminated_at?: number;
  },
): Promise<string> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO gpu_pods (id, handle, key_owner_account_id, credential_id, provider,
       beneficiary_account_id, spec, gpu_type_id, gpu_count, cloud, state, desired_state,
       max_runtime_minutes, deadline, cost_per_hr, running_since, terminated_at)
     VALUES ($1, $2, $3, $4, 'runpod', $3, '{}', 'NVIDIA RTX A4000', 1, 'SECURE', $5,
       'running', 600, now() + interval '10 hours', $6, $7, $8)`,
    [
      id,
      handle(),
      owner,
      credential_id,
      state,
      cost_per_hr,
      at(intervals[0][1]),
      terminated_at == null ? null : at(terminated_at),
    ],
  );
  for (const [s, from, to] of intervals) {
    await getPool().query(
      `INSERT INTO gpu_pod_state_intervals (id, pod_id, key_owner_account_id, state, started, ended)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), id, owner, s, at(from), to == null ? null : at(to)],
    );
  }
  return id;
}

async function confirm(account_id: string, yes = true) {
  return await confirmAccountChecksLocal(
    { account_id, confirm: yes, fresh_auth_verified: true },
    { accountWriteFence, isHomeBay: async () => true },
  );
}

async function alerts(credential_id: string) {
  const { rows } = await getPool().query(
    `SELECT kind, severity, resolved_at IS NOT NULL AS resolved FROM gpu_alerts
      WHERE credential_id = $1 ORDER BY opened, kind`,
    [credential_id],
  );
  return rows;
}

async function paused(credential_id: string) {
  const { rows } = await getPool().query(
    "SELECT paused_reason FROM gpu_key_fences WHERE credential_id = $1",
    [credential_id],
  );
  return rows[0]?.paused_reason ?? null;
}

function watcher(owner: string, credential_id: string) {
  return (ms: number, balance: { balance?: number; spendPerHour?: number }) =>
    watchProviderAccount(
      { credential_id, key_owner_account_id: owner },
      { getAccountBalance: async () => balance, now: () => T0 + ms },
    );
}

describeDb("GPU provider-account checks", () => {
  beforeAll(async () => {
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS accounts (account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN, groups TEXT[], email_address TEXT)",
    );
    await syncSchema({
      external_credentials: SCHEMA.external_credentials,
      gpu_key_fences: SCHEMA.gpu_key_fences,
      gpu_alerts: SCHEMA.gpu_alerts,
      gpu_key_events: SCHEMA.gpu_key_events,
      gpu_budget_layers: SCHEMA.gpu_budget_layers,
      gpu_budget_events: SCHEMA.gpu_budget_events,
      gpu_pods: SCHEMA.gpu_pods,
      gpu_pod_state_intervals: SCHEMA.gpu_pod_state_intervals,
      gpu_pod_events: SCHEMA.gpu_pod_events,
      gpu_pod_reservations: SCHEMA.gpu_pod_reservations,
      gpu_provider_account_watch: SCHEMA.gpu_provider_account_watch,
      gpu_worker_leases: SCHEMA.gpu_worker_leases,
      gpu_worker_overrides: SCHEMA.gpu_worker_overrides,
    });
  });

  it("is off until the owner confirms the account for the connected key; a new key starts unconfirmed", async () => {
    const owner = randomUUID();
    const identity = randomUUID();
    const key = await connectKey(owner, identity);
    const watch = watcher(owner, key);
    const asked = jest.fn(async () => ({ balance: 10 }));
    expect(
      await watchProviderAccount(
        { credential_id: key, key_owner_account_id: owner },
        { getAccountBalance: asked, now: () => T0 },
      ),
    ).toEqual({ checked: false, reason: "unconfirmed" });
    expect(asked).not.toHaveBeenCalled();
    expect(
      (await getAccountChecksLocal({ account_id: owner }, here)).state,
    ).toBe("off");
    expect((await confirm(owner)).state).toBe("on");
    expect((await watch(0, { balance: 10, spendPerHour: 0 })).checked).toBe(
      true,
    );
    // replaced by a new key for the same account: unconfirmed again
    await revoke(key);
    const next = await connectKey(owner, identity);
    expect(
      (await getAccountChecksLocal({ account_id: owner }, here)).state,
    ).toBe("off");
    expect((await watcher(owner, next)(MINUTE, { balance: 10 })).reason).toBe(
      "unconfirmed",
    );
  });

  it("a second key on the same account turns the checks off (with a warning) until it is gone", async () => {
    const owner = randomUUID();
    const identity = randomUUID();
    const key = await connectKey(owner, identity);
    await confirm(owner);
    const other = await connectKey(randomUUID(), identity);
    const watch = watcher(owner, key);
    expect(await watch(0, { balance: 10, spendPerHour: 0 })).toEqual({
      checked: false,
      reason: "shared",
    });
    expect(
      (await getAccountChecksLocal({ account_id: owner }, here)).state,
    ).toBe("shared");
    expect(await alerts(key)).toEqual([
      { kind: "account_checks_disabled", severity: "warning", resolved: false },
    ]);
    await revoke(other);
    expect(
      (await watch(MINUTE, { balance: 10, spendPerHour: 0 })).checked,
    ).toBe(true);
    expect(await alerts(key)).toEqual([
      { kind: "account_checks_disabled", severity: "warning", resolved: true },
    ]);
  });

  it("the spend rate needs 2 consecutive passes; critical pauses; in tolerance resolves (the pause stays)", async () => {
    const owner = randomUUID();
    const key = await connectKey(owner, randomUUID());
    await confirm(owner);
    // ours: $1/h compute + $0.05/h disk
    await pod(owner, key, {
      state: "running",
      cost_per_hr: 1,
      intervals: [["running", 0, undefined]],
    });
    expect((await expectedRate([key])).toNumber()).toBeCloseTo(1.05);
    const watch = watcher(owner, key);
    expect((await watch(1 * MINUTE, { spendPerHour: 1.05 })).rate).toBe("ok");
    // over x 1.2 + 0.25 = 1.51: once is nothing
    expect((await watch(2 * MINUTE, { spendPerHour: 1.6 })).rate).toBe(
      undefined,
    );
    expect(await alerts(key)).toEqual([]);
    expect((await watch(3 * MINUTE, { spendPerHour: 1.6 })).rate).toBe(
      "warning",
    );
    // over x 2 + 2 = 4.1: twice to be critical
    expect((await watch(4 * MINUTE, { spendPerHour: 5 })).rate).toBe("warning");
    expect(await paused(key)).toBe(null);
    expect((await watch(5 * MINUTE, { spendPerHour: 5 })).rate).toBe(
      "critical",
    );
    expect(await paused(key)).toBe("account_spend_rate");
    expect(await alerts(key)).toEqual([
      { kind: "account_spend_rate", severity: "critical", resolved: false },
    ]);
    expect((await watch(6 * MINUTE, { spendPerHour: 1.05 })).rate).toBe("ok");
    expect(await alerts(key)).toEqual([
      { kind: "account_spend_rate", severity: "critical", resolved: true },
    ]);
    expect(await paused(key)).toBe("account_spend_rate");
  });

  it("the balance is compared over 30 minutes against E's growth; a deposit starts over", async () => {
    const owner = randomUUID();
    const key = await connectKey(owner, randomUUID());
    await confirm(owner);
    await pod(owner, key, {
      state: "running",
      cost_per_hr: 1,
      intervals: [["running", 0, undefined]],
    });
    const watch = watcher(owner, key);
    expect((await watch(0, { balance: 100 })).balance).toBe("window");
    // too soon to compare
    expect((await watch(10 * MINUTE, { balance: 99.8 })).balance).toBe(
      "window",
    );
    // 40 min at $1.05/h = $0.70: as expected
    expect((await watch(40 * MINUTE, { balance: 99.3 })).balance).toBe("ok");
    // a deposit: no comparison, the window starts again
    expect((await watch(50 * MINUTE, { balance: 150 })).balance).toBe(
      "deposit",
    );
    expect((await watch(70 * MINUTE, { balance: 149 })).balance).toBe("window");
    // 40 min later: E grew $0.70, the balance dropped $5: a warning
    // (> 0.7 x 1.25 + 1), not critical (> 0.7 x 2 + 10)
    expect((await watch(90 * MINUTE, { balance: 145 })).balance).toBe(
      "warning",
    );
    expect(await paused(key)).toBe(null);
    // then $30 in 30 min: critical, paused
    expect((await watch(120 * MINUTE, { balance: 115 })).balance).toBe(
      "critical",
    );
    expect(await paused(key)).toBe("account_balance_drop");
    expect(await alerts(key)).toEqual([
      { kind: "account_balance_drop", severity: "critical", resolved: false },
    ]);
    // back in tolerance: resolved
    expect((await watch(150 * MINUTE, { balance: 114.5 })).balance).toBe("ok");
    expect((await alerts(key))[0].resolved).toBe(true);
  });

  it("E: compute over running and terminating, disk over the provider lifetime; a stopped pod is disk only; billing never enters it", async () => {
    const owner = randomUUID();
    const key = await connectKey(owner, randomUUID());
    // ran 1 h, stopped 1 h, running again since
    const id = await pod(owner, key, {
      state: "running",
      cost_per_hr: 1,
      intervals: [
        ["running", 0, HOUR],
        ["stopped", HOUR, 2 * HOUR],
        ["running", 2 * HOUR, undefined],
      ],
    });
    // compute 2 h x $1 + disk 3 h x $0.05
    expect((await expectedSpend([key], at(3 * HOUR))).toNumber()).toBeCloseTo(
      2.15,
    );
    // a pod spanning the baseline: only its overlap with the window counts
    const e1 = await expectedSpend([key], at(1.5 * HOUR));
    const e2 = await expectedSpend([key], at(2.5 * HOUR));
    // [1.5, 2.5]: 0.5 h compute + 1 h disk
    expect(e2.minus(e1).toNumber()).toBeCloseTo(0.55);
    // a billing correction changes nothing here
    await getPool().query(
      "UPDATE gpu_pods SET billing_state = 'billed', billed_usd = 0.01 WHERE id = $1",
      [id],
    );
    expect((await expectedSpend([key], at(3 * HOUR))).toNumber()).toBeCloseTo(
      2.15,
    );
    // stopped now: the rate is its disk alone
    await getPool().query(
      "UPDATE gpu_pods SET state = 'stopped' WHERE id = $1",
      [id],
    );
    expect((await expectedRate([key])).toNumber()).toBeCloseTo(0.05);
    // terminating still bills compute; terminated nothing
    const ended = await pod(owner, key, {
      state: "terminated",
      cost_per_hr: 2,
      intervals: [
        ["running", 0, HOUR],
        ["terminating", HOUR, 1.5 * HOUR],
        ["terminated", 1.5 * HOUR, undefined],
      ],
      terminated_at: 1.5 * HOUR,
    });
    expect((await expectedSpend([key], at(3 * HOUR))).toNumber()).toBeCloseTo(
      2.15 + 2 * 1.5 + 0.05 * 1.5,
    );
    expect((await expectedRate([key])).toNumber()).toBeCloseTo(0.05);
    expect(ended).toBeTruthy();
  });

  it("a pod a forced removal left unmanaged counts for nothing, so provider spend isn't explained away", async () => {
    const owner = randomUUID();
    const identity = randomUUID();
    const old = await connectKey(owner, identity);
    const id = await pod(owner, old, {
      state: "running",
      cost_per_hr: 3,
      intervals: [["running", 0, undefined]],
    });
    expect((await expectedRate([old])).toNumber()).toBeCloseTo(3.05);
    expect((await expectedSpend([old], at(HOUR))).toNumber()).toBeCloseTo(3.05);
    await getPool().query(
      "UPDATE gpu_pods SET unmanaged_at = $2 WHERE id = $1",
      [id, at(10 * MINUTE)],
    );
    await revoke(old);
    expect((await expectedRate([old])).toNumber()).toBe(0);
    expect((await expectedSpend([old], at(HOUR))).toNumber()).toBe(0);
    // a new key on the same account, confirmed: $3/h of spend is RunPod's
    // alone now (over 0 x 2 + $2/h), so it alerts
    const key = await connectKey(owner, identity);
    await confirm(owner);
    const watch = watcher(owner, key);
    await watch(HOUR, { spendPerHour: 3 });
    expect((await watch(HOUR + MINUTE, { spendPerHour: 3 })).rate).toBe(
      "critical",
    );
  });

  it("a key RunPod won't show the account's balance: the checks say so, without a pause, until a sample succeeds", async () => {
    const owner = randomUUID();
    const key = await connectKey(owner, randomUUID());
    await confirm(owner);
    await watcher(owner, key)(0, { balance: 100, spendPerHour: 0 });
    const refused = await watchProviderAccount(
      { credential_id: key, key_owner_account_id: owner },
      {
        now: () => T0 + MINUTE,
        getAccountBalance: async () => {
          throw new RunpodApiError("forbidden", 200);
        },
      },
    );
    expect(refused).toEqual({ checked: false, reason: "no_access" });
    expect(
      (await getAccountChecksLocal({ account_id: owner }, here)).state,
    ).toBe("no_access");
    expect(await alerts(key)).toEqual([
      { kind: "account_checks_disabled", severity: "warning", resolved: false },
    ]);
    expect(await paused(key)).toBe(null);
    const { rows } = await getPool().query(
      "SELECT last_asked_at, last_balance_usd FROM gpu_provider_account_watch WHERE credential_id = $1",
      [key],
    );
    // readings cleared; the refusal is the latest observation
    expect(rows[0]).toEqual({
      last_asked_at: at(MINUTE),
      last_balance_usd: null,
    });
    // RunPod answers again: on, and the warning ends
    expect(
      (await watcher(owner, key)(2 * MINUTE, { balance: 100, spendPerHour: 0 }))
        .checked,
    ).toBe(true);
    expect(
      (await getAccountChecksLocal({ account_id: owner }, here)).state,
    ).toBe("on");
    expect(await alerts(key)).toEqual([
      { kind: "account_checks_disabled", severity: "warning", resolved: true },
    ]);
  });

  it("each reason the checks are off is its own alert: no access, then a second key, then back", async () => {
    const owner = randomUUID();
    const identity = randomUUID();
    const key = await connectKey(owner, identity);
    await confirm(owner);
    const refuse = (ms: number) =>
      watchProviderAccount(
        { credential_id: key, key_owner_account_id: owner },
        {
          now: () => T0 + ms,
          getAccountBalance: async () => {
            throw new RunpodApiError("forbidden", 200);
          },
        },
      );
    const open = async () =>
      (await listAlertsLocal({ account_id: owner }))
        .filter((a) => a.kind === "account_checks_disabled")
        .map((a) => a.message);
    expect((await refuse(MINUTE)).reason).toBe("no_access");
    expect(await open()).toEqual([expect.stringContaining("read the account")]);
    const other = await connectKey(randomUUID(), identity);
    expect((await refuse(2 * MINUTE)).reason).toBe("shared");
    expect(
      (await getAccountChecksLocal({ account_id: owner }, here)).state,
    ).toBe("shared");
    expect(await open()).toEqual([
      expect.stringContaining("another key connected to CoCalc uses it"),
    ]);
    await revoke(other);
    expect((await refuse(3 * MINUTE)).reason).toBe("no_access");
    expect(await open()).toEqual([expect.stringContaining("read the account")]);
  });

  it("an answer with neither number is no sample: the last state stands", async () => {
    const owner = randomUUID();
    const key = await connectKey(owner, randomUUID());
    await confirm(owner);
    await watcher(owner, key)(0, { balance: 100, spendPerHour: 0 });
    expect(await watcher(owner, key)(MINUTE, {})).toEqual({
      checked: false,
      reason: "no_metrics",
    });
    const { rows } = await getPool().query(
      "SELECT last_asked_at, last_balance_usd FROM gpu_provider_account_watch WHERE credential_id = $1",
      [key],
    );
    expect(rows[0].last_asked_at).toEqual(at(0));
    expect(Number(rows[0].last_balance_usd)).toBe(100);
  });

  it("a lease lost while RunPod answers writes nothing", async () => {
    const owner = randomUUID();
    const key = await connectKey(owner, randomUUID());
    await confirm(owner);
    await expect(
      watchProviderAccount(
        { credential_id: key, key_owner_account_id: owner },
        {
          now: () => T0,
          getAccountBalance: async () => ({ balance: 1, spendPerHour: 99 }),
          guard: async () => {
            throw Error("lease lost");
          },
        },
      ),
    ).rejects.toThrow("lease lost");
    const { rows } = await getPool().query(
      "SELECT last_asked_at FROM gpu_provider_account_watch WHERE credential_id = $1",
      [key],
    );
    expect(rows[0].last_asked_at).toBe(null);
    expect(await alerts(key)).toEqual([]);
  });

  it("a sample no newer than the last one changes nothing", async () => {
    const owner = randomUUID();
    const key = await connectKey(owner, randomUUID());
    await confirm(owner);
    const watch = watcher(owner, key);
    await watch(10 * MINUTE, { balance: 100, spendPerHour: 0 });
    expect(await watch(5 * MINUTE, { balance: 1, spendPerHour: 99 })).toEqual({
      checked: false,
      reason: "stale",
    });
    const { rows } = await getPool().query(
      "SELECT last_balance_usd, rate_warning_passes FROM gpu_provider_account_watch WHERE credential_id = $1",
      [key],
    );
    expect(Number(rows[0].last_balance_usd)).toBe(100);
    expect(rows[0].rate_warning_passes).toBe(0);
  });

  it("a hidden co-owner's spending: a pause, explained; the owner resumes, or withdraws the confirmation", async () => {
    const owner = randomUUID();
    const key = await connectKey(owner, randomUUID());
    await confirm(owner);
    const watch = watcher(owner, key);
    // no pods of ours; someone else spends $20 in 30 min
    await watch(0, { balance: 100 });
    expect((await watch(30 * MINUTE, { balance: 80 })).balance).toBe(
      "critical",
    );
    expect(await paused(key)).toBe("account_balance_drop");
    expect(
      (
        await resumeGpuLaunchesLocal(
          { account_id: owner, fresh_auth_verified: true },
          { accountWriteFence, isHomeBay: async () => true },
        )
      ).resumed,
    ).toBe(1);
    expect(await paused(key)).toBe(null);
    // it isn't theirs alone after all: withdrawn, the alerts end, no checks
    expect((await confirm(owner, false)).state).toBe("off");
    expect(await alerts(key)).toEqual([
      { kind: "account_balance_drop", severity: "critical", resolved: true },
    ]);
    expect((await watch(60 * MINUTE, { balance: 50 })).reason).toBe(
      "unconfirmed",
    );
    // confirming needs fresh auth and a yes or no
    await expect(
      confirmAccountChecksLocal(
        { account_id: owner, confirm: true },
        { accountWriteFence, isHomeBay: async () => true },
      ),
    ).rejects.toThrow("sign in again");
    await expect(
      confirmAccountChecksLocal(
        { account_id: owner, confirm: "yes", fresh_auth_verified: true },
        { accountWriteFence, isHomeBay: async () => true },
      ),
    ).rejects.toThrow("confirm (true) or withdraw");
  });

  const watchRow = async (credential_id: string) =>
    (
      await getPool().query(
        `SELECT confirmed_at IS NOT NULL AS confirmed, disabled_reason, last_asked_at,
                last_balance_usd, baseline_at, rate_warning_passes
           FROM gpu_provider_account_watch WHERE credential_id = $1`,
        [credential_id],
      )
    ).rows[0];
  const ended = {
    confirmed: false,
    disabled_reason: null,
    last_asked_at: null,
    last_balance_usd: null,
    baseline_at: null,
    rate_warning_passes: 0,
  };

  it("withdrawing and confirming again (or a transfer back) lets the checks raise new alerts", async () => {
    const owner = randomUUID();
    const identity = randomUUID();
    const key = await connectKey(owner, identity);
    await confirm(owner);
    const watch = watcher(owner, key);
    await watch(0, { balance: 100 });
    expect((await watch(30 * MINUTE, { balance: 80 })).balance).toBe(
      "critical",
    );
    await confirm(owner, false);
    expect((await alerts(key)).map((a) => a.resolved)).toEqual([true]);
    // confirmed again with the same key: the condition opens a new alert
    await confirm(owner);
    await watch(60 * MINUTE, { balance: 70 });
    expect((await watch(90 * MINUTE, { balance: 50 })).balance).toBe(
      "critical",
    );
    expect((await alerts(key)).map((a) => a.resolved)).toEqual([true, false]);
    // A to B and back to A: A's checks can raise again
    const b = randomUUID();
    const keyB = await connectKey(b, identity);
    await confirm(b);
    await revoke(keyB);
    await confirm(owner);
    await watch(120 * MINUTE, { balance: 40 });
    expect((await watch(150 * MINUTE, { balance: 20 })).balance).toBe(
      "critical",
    );
    expect((await alerts(key)).map((a) => a.resolved)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("the key's removal or replacement ends its confirmation, samples and account alerts; the new key starts unconfirmed", async () => {
    const owner = randomUUID();
    const identity = randomUUID();
    const key = await connectKey(owner, identity);
    await confirm(owner);
    const watch = watcher(owner, key);
    await watch(0, { balance: 100, spendPerHour: 0 });
    await watch(30 * MINUTE, { balance: 80 });
    // (closeKeyFence runs this, in the removal's or replacement's transaction)
    await onKeyGone({ credential_id: key, by: "removed" });
    expect((await alerts(key)).every((a) => a.resolved)).toBe(true);
    expect(await watchRow(key)).toEqual(ended);
    await revoke(key);
    await connectKey(owner, identity);
    expect(
      (await getAccountChecksLocal({ account_id: owner }, here)).state,
    ).toBe("off");
  });

  it("reporting the key compromised ends its confirmation at once (its fence admits nothing)", async () => {
    const owner = randomUUID();
    const key = await connectKey(owner, randomUUID());
    await confirm(owner);
    await watcher(owner, key)(0, { balance: 100, spendPerHour: 0 });
    expect(
      (await getAccountChecksLocal({ account_id: owner }, here)).state,
    ).toBe("on");
    let reads = 0;
    await reportCompromisedLocal(
      {
        account_id: owner,
        confirm_cocalc_only: true,
        fresh_auth_verified: true,
      },
      {
        keyFence: async (_a: string, fn: any) => await inTransaction(fn),
        // the request's check, then nothing for the cleanup pass to do here
        getCleanup: async () =>
          ++reads === 1 ? ({ credential_id: key } as any) : undefined,
      },
    );
    expect(await watchRow(key)).toEqual(ended);
    expect(
      (await getAccountChecksLocal({ account_id: owner }, here)).state,
    ).toBe("off");
  });

  it("another owner's confirmation of the same account replaces it, ending the old key's open account alerts", async () => {
    const a = randomUUID();
    const identity = randomUUID();
    const keyA = await connectKey(a, identity);
    await confirm(a);
    const watchA = watcher(a, keyA);
    await watchA(0, { balance: 100 });
    expect((await watchA(30 * MINUTE, { balance: 80 })).balance).toBe(
      "critical",
    );
    expect(await alerts(keyA)).toEqual([
      { kind: "account_balance_drop", severity: "critical", resolved: false },
    ]);
    const b = randomUUID();
    const keyB = await connectKey(b, identity);
    // two keys on the account: B's checks stay off until one is gone
    expect((await confirm(b)).state).toBe("shared");
    expect(await alerts(keyA)).toEqual([
      { kind: "account_balance_drop", severity: "critical", resolved: true },
    ]);
    const { rows } = await getPool().query(
      "SELECT resolved_by FROM gpu_alerts WHERE credential_id = $1",
      [keyA],
    );
    expect(rows[0].resolved_by).toBe("confirmation_replaced");
    expect((await getAccountChecksLocal({ account_id: a }, here)).state).toBe(
      "off",
    );
    expect((await watchA(60 * MINUTE, { balance: 70 })).reason).toBe(
      "unconfirmed",
    );
    expect(keyB).toBeTruthy();
  });

  it("a lease lost while RunPod answers the account read: the pass ends no rejected-key alert", async () => {
    const owner = randomUUID();
    const key = await connectKey(owner, randomUUID());
    await confirm(owner);
    await raiseAlert({
      key_owner_account_id: owner,
      credential_id: key,
      kind: "key_rejected",
      severity: "critical",
      dedupe_key: "key",
      observed_at: at(0),
    });
    let answered = false;
    await expect(
      reconcileKey(
        {
          credential_id: key,
          key_owner_account_id: owner,
          deadline: T0 + HOUR + 30_000,
        },
        {
          now: () => T0 + HOUR,
          guard: async () => {
            if (answered) throw Error("lease lost");
          },
          getReconcile: async () => ({
            credential_id: key,
            listPods: async ({ onPage }: any = {}) => {
              await onPage?.([]);
              return [];
            },
            getPod: async () => undefined,
            // an answer with no numbers: the check writes nothing itself
            getAccountBalance: async () => {
              answered = true;
              return {};
            },
          }),
        },
      ),
    ).rejects.toThrow("lease lost");
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM gpu_alerts WHERE credential_id = $1 AND kind = 'key_rejected' AND resolved_at IS NULL",
      [key],
    );
    expect(rows[0].n).toBe(1);
  });

  it("a complete reconcile pass checks a confirmed account, once, and only then", async () => {
    const owner = randomUUID();
    const key = await connectKey(owner, randomUUID());
    const getAccountBalance = jest.fn(async () => ({
      balance: 10,
      spendPerHour: 0,
    }));
    const pass = (ms: number) =>
      reconcileKey(
        {
          credential_id: key,
          key_owner_account_id: owner,
          deadline: T0 + ms + 30_000,
        },
        {
          now: () => T0 + ms,
          getReconcile: async () => ({
            credential_id: key,
            listPods: async ({ onPage }: any = {}) => {
              await onPage?.([]);
              return [];
            },
            getPod: async () => undefined,
            getAccountBalance,
          }),
        },
      );
    expect((await pass(0)).complete).toBe(true);
    expect(getAccountBalance).not.toHaveBeenCalled();
    await confirm(owner);
    expect((await pass(HOUR)).complete).toBe(true);
    expect(getAccountBalance).toHaveBeenCalledTimes(1);
    expect(
      (await getAccountChecksLocal({ account_id: owner }, here))
        .last_checked_at,
    ).toBe(at(HOUR).toISOString());
    // RunPod refuses the account read after a complete inventory: the pass
    // stays complete, and the checks say no_access
    getAccountBalance.mockRejectedValueOnce(
      new RunpodApiError("forbidden", 200),
    );
    expect((await pass(2 * HOUR)).complete).toBe(true);
    expect(
      (await getAccountChecksLocal({ account_id: owner }, here)).state,
    ).toBe("no_access");
    // RunPod rejects the key itself (401) during the account read: the
    // rejected-key handling, with its pause
    getAccountBalance.mockRejectedValueOnce(new RunpodApiError("auth", 401));
    expect((await pass(3 * HOUR)).rejected).toBe(true);
    expect(await paused(key)).toBe("key_rejected");
    expect((await alerts(key)).map((a) => a.kind)).toContain("key_rejected");
    // a later complete pass with a good account read ends it; and when the
    // key is rejected again on the account read, with that alert already
    // open from an earlier pass, it stays open and the key paused
    await getPool().query(
      "UPDATE gpu_key_fences SET paused_reason = NULL WHERE credential_id = $1",
      [key],
    );
    getAccountBalance.mockRejectedValueOnce(new RunpodApiError("auth", 401));
    expect((await pass(4 * HOUR)).rejected).toBe(true);
    expect(await paused(key)).toBe("key_rejected");
    const open = await getPool().query(
      "SELECT count(*)::int AS n FROM gpu_alerts WHERE credential_id = $1 AND kind = 'key_rejected' AND resolved_at IS NULL",
      [key],
    );
    expect(open.rows[0].n).toBe(1);
    expect((await pass(5 * HOUR)).complete).toBe(true);
    const still = await getPool().query(
      "SELECT count(*)::int AS n FROM gpu_alerts WHERE credential_id = $1 AND kind = 'key_rejected' AND resolved_at IS NULL",
      [key],
    );
    expect(still.rows[0].n).toBe(0);
  });
});
