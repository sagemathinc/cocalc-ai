/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Account-level spend checks (step 5d-2b; ~/ops2/runpod/STEP5D2.md v6).

RunPod reports an account's balance and current spend rate, not per key. So
these numbers mean something only for an account that CoCalc's pods alone
use. The checks run for a provider account (identity) only while:

1. its owner confirmed, with the key now connected, that the RunPod account
   is used only by them, only for CoCalc (a new key starts unconfirmed);
2. exactly one active key on this bay has that identity (a second one, from
   any owner, turns the checks off for both, with a warning to the owner who
   confirmed it).

Across bays uniqueness can't be proven: the confirmation's wording covers it,
and a hidden co-owner fails safe (a pause, explained; the owner resumes or
withdraws the confirmation).

Each pass (the reconciler's, after a complete inventory) asks RunPod once,
and compares:
- the spend rate with CoCalc's instantaneous rate for the identity (compute
  for running and terminating pods, plus a disk allowance for every pod that
  still exists at RunPod), on 2 consecutive passes;
- the balance drop over a window of at least 30 minutes with E, CoCalc's
  expected spend: compute over the pods' running and terminating intervals
  (gpu_pod_state_intervals) plus the disk allowance over each pod's provider
  lifetime. A deposit (the balance went up) starts a new window.

A critical finding pauses the key's launches until the owner resumes. A later
pass within tolerance resolves the alert. Every write happens under the
key's live fence and the watch row's lock, and only for a sample newer than
the last one, so overlapping passes can't move the baseline backward.
*/

import { randomUUID } from "node:crypto";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import { isValidUUID } from "@cocalc/util/misc";
import {
  RunpodApiError,
  type RunpodAccountBalance,
} from "@cocalc/cloud/runpod/client";
import type { InterBayGpuApi } from "@cocalc/conat/inter-bay/api";
import type { GpuAccountChecks } from "@cocalc/util/gpu/types";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { lockGpuAccountFence } from "@cocalc/server/gpu/account-fence";
import {
  raiseAlert,
  resolveAlert,
  underLiveFence,
  type GpuAlertKind,
} from "@cocalc/server/gpu/alerts";
import { budgetHomeClient } from "@cocalc/server/gpu/budget-api";
import { inTransaction, requireHomeBay } from "@cocalc/server/gpu/pods";
import {
  endAccountAlerts,
  endAccountWatch,
  lockProviderIdentity,
} from "@cocalc/server/gpu/account-watch-db";

const log = getLogger("server:gpu:account-watch");

type Db = Pick<PoolClient, "query">;
type Money = ReturnType<typeof toDecimal>;

const MINUTE = 60_000;

// What CoCalc counts for a pod's disk while RunPod still has it (running,
// stopped or terminating), per hour.
export const ACCOUNT_DISK_USD_PER_HR = 0.05;
// the balance is compared over at least this long
export const ACCOUNT_BALANCE_WINDOW_MS = 30 * MINUTE;
// spend rate: over ours x 1.2 + $0.25/h (warning), x 2 + $2/h (critical and
// a pause), on this many consecutive passes
export const ACCOUNT_RATE_PASSES = 2;
const RATE = {
  warning: { factor: 1.2, plus: 0.25 },
  critical: { factor: 2, plus: 2 },
};
// balance: a drop over E's increase x 1.25 + $1 (warning), x 2 + $10
// (critical and a pause)
const DROP = {
  warning: { factor: 1.25, plus: 1 },
  critical: { factor: 2, plus: 10 },
};

const PROVIDER = "runpod";
const KEY_KIND = "gpu-provider-api-key";
const RATE_KIND: GpuAlertKind = "account_spend_rate";
const DROP_KIND: GpuAlertKind = "account_balance_drop";
const OFF_KIND: GpuAlertKind = "account_checks_disabled";
// (one open alert of each kind per key; the checks are off for one of two
// reasons, each its own alert, so neither's text outlives it)
const DEDUPE = "account";
const OFF_SHARED = "shared";
const OFF_NO_ACCESS = "no_access";

export interface ProviderIdentity {
  provider: string;
  kind: string;
  id: string;
}

// The provider account a stored key belongs to, as verified at connect.
async function identityOf(
  credential_id: string,
  db: Db = getPool(),
): Promise<ProviderIdentity | undefined> {
  const { rows } = await db.query(
    `SELECT provider, metadata->>'provider_account_kind' AS kind,
            metadata->>'provider_account_id' AS id
       FROM external_credentials WHERE id = $1 AND kind = $2`,
    [credential_id, KEY_KIND],
  );
  const r = rows[0];
  if (!r?.kind || !r?.id) return undefined;
  return { provider: r.provider ?? PROVIDER, kind: r.kind, id: r.id };
}

// Every stored key (active or not) on this bay for the identity: their pods
// are what RunPod bills the account for.
async function identityCredentials(
  identity: ProviderIdentity,
  db: Db,
  { active }: { active: boolean },
): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT id FROM external_credentials
      WHERE kind = $1 AND provider = $2
        AND metadata->>'provider_account_kind' = $3
        AND metadata->>'provider_account_id' = $4
        AND ($5::boolean IS FALSE OR revoked IS NULL)`,
    [KEY_KIND, identity.provider, identity.kind, identity.id, active],
  );
  return rows.map((r) => r.id);
}

// A pod's compute rate: what RunPod reported, else the rate reserved for it.
const POD_RATE = `COALESCE(p.cost_per_hr, (
    SELECT r.hourly_usd FROM gpu_pod_reservations r
      JOIN gpu_budget_layers l ON l.id = r.layer_id AND l.scope_kind = 'key'
     WHERE r.pod_id = p.id ORDER BY r.created LIMIT 1), 0)`;

// E(t): CoCalc's expected spend for the identity's pods up to `t`, from the
// observed-state ledger. Never billed amounts (5d-2a checks those per pod).
// Only managed pods: one a forced removal left unmanaged is out of CoCalc's
// sight (the owner was told to terminate it at RunPod), and the confirmation
// it was under ended with that removal.
export async function expectedSpend(
  credential_ids: string[],
  t: Date,
  db: Db = getPool(),
): Promise<Money> {
  if (credential_ids.length === 0) return toDecimal(0);
  const { rows } = await db.query(
    `SELECT
       COALESCE((SELECT SUM(${POD_RATE} * EXTRACT(EPOCH FROM
                   (LEAST(COALESCE(i.ended, $2), $2) - i.started)) / 3600)
          FROM gpu_pod_state_intervals i JOIN gpu_pods p ON p.id = i.pod_id
         WHERE p.credential_id = ANY($1::uuid[]) AND p.unmanaged_at IS NULL
           AND i.state IN ('running', 'terminating') AND i.started < $2), 0)
       AS compute,
       COALESCE((SELECT SUM(EXTRACT(EPOCH FROM
                   (LEAST(COALESCE(p.terminated_at, $2), $2) - p.running_since)) / 3600)
          FROM gpu_pods p
         WHERE p.credential_id = ANY($1::uuid[]) AND p.unmanaged_at IS NULL
           AND p.running_since IS NOT NULL AND p.running_since < $2), 0)
       AS disk_hours`,
    [credential_ids, t],
  );
  return toDecimal(rows[0].compute ?? 0).plus(
    toDecimal(rows[0].disk_hours ?? 0).times(ACCOUNT_DISK_USD_PER_HR),
  );
}

// CoCalc's instantaneous rate for the identity, per hour.
export async function expectedRate(
  credential_ids: string[],
  db: Db = getPool(),
): Promise<Money> {
  if (credential_ids.length === 0) return toDecimal(0);
  const { rows } = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN p.state IN ('running', 'terminating')
                         THEN ${POD_RATE} ELSE 0 END), 0) AS compute,
       COUNT(*) FILTER (WHERE p.state IN ('running', 'stopped', 'terminating'))
         AS disks
       FROM gpu_pods p
      WHERE p.credential_id = ANY($1::uuid[]) AND p.unmanaged_at IS NULL`,
    [credential_ids],
  );
  return toDecimal(rows[0].compute ?? 0).plus(
    toDecimal(rows[0].disks ?? 0).times(ACCOUNT_DISK_USD_PER_HR),
  );
}

const over = (
  observed: Money,
  ours: Money,
  t: { factor: number; plus: number },
) => observed.gt(ours.times(t.factor).plus(t.plus));

export interface AccountWatchOutcome {
  checked: boolean;
  // why not: no identity, not confirmed, a second key, a stale sample,
  // or the key's fence isn't live
  reason?:
    | "unidentified"
    | "unconfirmed"
    | "shared"
    | "stale"
    | "fence"
    | "no_access"
    | "no_metrics";
  rate?: "ok" | "warning" | "critical";
  balance?: "ok" | "warning" | "critical" | "deposit" | "window";
}

// One check of the key's provider account. `getAccountBalance` is the pass's
// bounded RunPod call; `now` is the pass's clock.
export async function watchProviderAccount(
  {
    credential_id,
    key_owner_account_id,
  }: { credential_id: string; key_owner_account_id: string },
  deps: {
    getAccountBalance: () => Promise<RunpodAccountBalance>;
    now?: () => number;
    // the worker's lease check (throws once lost), before anything is
    // written: RunPod may answer after the lease is gone
    guard?: () => Promise<void>;
  },
): Promise<AccountWatchOutcome> {
  const clock = deps.now ?? Date.now;
  const identity = await identityOf(credential_id);
  if (!identity) return { checked: false, reason: "unidentified" };
  const watch = await readWatch(identity);
  if (
    !watch?.confirmed_at ||
    watch.credential_id !== credential_id ||
    watch.key_owner_account_id !== key_owner_account_id
  ) {
    return { checked: false, reason: "unconfirmed" };
  }
  // the confirmation this pass works under: a withdrawal and a new
  // confirmation meanwhile (a new id) make whatever it learns stale
  const epoch = watch.confirmation_id;
  const current = (w: any) =>
    w &&
    w.credential_id === credential_id &&
    w.confirmed_at &&
    w.confirmation_id === epoch;
  // On this bay, exactly one active key may have this identity.
  const active = await identityCredentials(identity, getPool(), {
    active: true,
  });
  const observed_at = new Date(clock());
  const endOff = (db: Db, why: string, at: Date) =>
    resolveAlert(
      {
        credential_id,
        kind: OFF_KIND,
        dedupe_key: why,
        observed_at: at,
        by: "account_checks_resumed",
      },
      db,
    );
  const exclusive = (keys: string[]) =>
    keys.length === 1 && keys[0] === credential_id;
  // The checks are off while another key uses the account: a co-owner's pods
  // would be counted against ours. They start over once it is gone.
  // (its time is kept as the last observation: an older answer can't land
  // after it)
  const disable = async (db: Db, w: any, keys: number, at: Date) => {
    await db.query(
      `UPDATE gpu_provider_account_watch
          SET disabled_reason = 'shared', ${CLEARED_READINGS},
              last_asked_at = GREATEST(COALESCE(last_asked_at, $2), $2), updated = now()
        WHERE id = $1`,
      [w.id, at],
    );
    await raiseAlert(
      {
        key_owner_account_id,
        credential_id,
        kind: OFF_KIND,
        severity: "warning",
        dedupe_key: OFF_SHARED,
        details: { keys_on_account: keys },
        observed_at: at,
      },
      db,
    );
    // (the account's other reason is unknown now: not said any more)
    await endOff(db, OFF_NO_ACCESS, at);
  };
  const asked_at = new Date(clock());
  // How every answer (or refusal) from RunPod is applied: under the key's
  // live fence and the watch row's lock; never older than the last sample
  // (a slower overlapping pass); and only while this is still the account's
  // one key (a key for it connected while RunPod was asked commits before
  // this, since the connect takes the same lock, and one connected after
  // waits for this transaction).
  const finish = async (
    at: Date,
    apply: (db: Db, w: any) => Promise<AccountWatchOutcome>,
  ): Promise<AccountWatchOutcome> => {
    await deps.guard?.();
    return (
      (await underLiveFence(credential_id, async (db) => {
        const w = await lockWatch(db, identity);
        if (!current(w)) {
          return {
            checked: false,
            reason: "unconfirmed",
          } as AccountWatchOutcome;
        }
        // every outcome (a sample, a refusal, shared) moves last_asked_at
        if (w.last_asked_at && new Date(w.last_asked_at) >= at) {
          return { checked: false, reason: "stale" } as AccountWatchOutcome;
        }
        await lockProviderIdentity(db, identity);
        const keys = await identityCredentials(identity, db, { active: true });
        if (!exclusive(keys)) {
          await disable(db, w, keys.length, at);
          return { checked: false, reason: "shared" } as AccountWatchOutcome;
        }
        // and the lease still held now that the locks are (waiting for them
        // may have outlasted it)
        await deps.guard?.();
        return await apply(db, w);
      })) ?? { checked: false, reason: "fence" }
    );
  };
  // Another key on the account already: don't ask RunPod. Recorded through
  // the same guards (this observation's own time); if the other key is gone
  // by then, nothing is written and the next pass checks.
  if (!exclusive(active)) {
    return await finish(observed_at, async () => ({
      checked: false,
      reason: "shared",
    }));
  }
  let balance: RunpodAccountBalance;
  try {
    balance = await deps.getAccountBalance();
  } catch (err) {
    // The key can list pods but not read the account: the checks can't run
    // until it can. (A rejected key, 401, is the caller's: it ends more than
    // these checks.) Say so (the status, and a warning), rather than look on.
    if (err instanceof RunpodApiError && err.kind === "forbidden") {
      return await finish(asked_at, async (db, w) => {
        // (samples start over; this refusal is the latest observation)
        await db.query(
          `UPDATE gpu_provider_account_watch
              SET disabled_reason = 'no_access', ${CLEARED_READINGS},
                  last_asked_at = $2, updated = now()
            WHERE id = $1`,
          [w.id, asked_at],
        );
        await raiseAlert(
          {
            key_owner_account_id,
            credential_id,
            kind: OFF_KIND,
            severity: "warning",
            dedupe_key: OFF_NO_ACCESS,
            details: { reason: "no_account_access" },
            observed_at: asked_at,
          },
          db,
        );
        // the key is the account's only one (finish checked)
        await endOff(db, OFF_SHARED, asked_at);
        return { checked: false, reason: "no_access" };
      });
    }
    throw err;
  }
  // An answer with neither number checks nothing: not a sample (the last
  // state stands, and the next pass asks again).
  if (balance.balance == null && balance.spendPerHour == null) {
    log.warn("RunPod's account answer had no balance or spend rate");
    return { checked: false, reason: "no_metrics" };
  }
  return await finish(asked_at, async (db, w) => {
    const creds = await identityCredentials(identity, db, { active: false });
    const E = await expectedSpend(creds, asked_at, db);
    const out: AccountWatchOutcome = { checked: true };
    const set: Record<string, unknown> = {
      disabled_reason: null,
      last_asked_at: asked_at,
      last_expected_usd: moneyToDbString(E),
    };
    const alert = async (
      kind: GpuAlertKind,
      severity: "warning" | "critical",
      details: Record<string, unknown>,
    ) => {
      await raiseAlert(
        {
          key_owner_account_id,
          credential_id,
          kind,
          severity,
          dedupe_key: DEDUPE,
          details,
          observed_at: asked_at,
        },
        db,
      );
      if (severity === "critical") await pauseKey(db, credential_id, kind);
    };
    const resolve = (kind: GpuAlertKind) =>
      resolveAlert(
        {
          credential_id,
          kind,
          dedupe_key: DEDUPE,
          observed_at: asked_at,
          by: "account_in_tolerance",
        },
        db,
      );
    await endOff(db, OFF_SHARED, asked_at);
    await endOff(db, OFF_NO_ACCESS, asked_at);

    // The spend rate, on consecutive passes.
    if (balance.spendPerHour != null) {
      const observed = toDecimal(balance.spendPerHour);
      const ours = await expectedRate(creds, db);
      const critical = over(observed, ours, RATE.critical);
      const warning = critical || over(observed, ours, RATE.warning);
      const criticalPasses = critical ? Number(w.rate_critical_passes) + 1 : 0;
      const warningPasses = warning ? Number(w.rate_warning_passes) + 1 : 0;
      set.rate_critical_passes = criticalPasses;
      set.rate_warning_passes = warningPasses;
      const details = {
        provider_usd_per_hr: moneyToDbString(observed),
        expected_usd_per_hr: moneyToDbString(ours),
      };
      if (criticalPasses >= ACCOUNT_RATE_PASSES) {
        out.rate = "critical";
        await alert(RATE_KIND, "critical", details);
      } else if (warningPasses >= ACCOUNT_RATE_PASSES) {
        out.rate = "warning";
        await alert(RATE_KIND, "warning", details);
      } else if (!warning) {
        out.rate = "ok";
        await resolve(RATE_KIND);
      }
    }

    // The balance, over a window.
    if (balance.balance != null) {
      const now = toDecimal(balance.balance);
      const sample = {
        baseline_at: asked_at,
        baseline_balance_usd: moneyToDbString(now),
        baseline_expected_usd: moneyToDbString(E),
      };
      set.last_balance_usd = moneyToDbString(now);
      const prev =
        w.last_balance_usd == null ? undefined : toDecimal(w.last_balance_usd);
      if (prev != null && now.gt(prev)) {
        // a deposit: both baselines start again
        out.balance = "deposit";
        Object.assign(set, sample);
      } else if (w.baseline_at == null) {
        out.balance = "window";
        Object.assign(set, sample);
      } else if (
        asked_at.getTime() - new Date(w.baseline_at).getTime() >=
        ACCOUNT_BALANCE_WINDOW_MS
      ) {
        const drop = toDecimal(w.baseline_balance_usd).minus(now);
        const grew = E.minus(toDecimal(w.baseline_expected_usd));
        // E only grows with time; a revival's correction lands here once
        const ours = grew.lt(0) ? toDecimal(0) : grew;
        const details = {
          provider_drop_usd: moneyToDbString(drop.lt(0) ? 0 : drop),
          expected_usd: moneyToDbString(ours),
          since: new Date(w.baseline_at).toISOString(),
        };
        if (over(drop, ours, DROP.critical)) {
          out.balance = "critical";
          await alert(DROP_KIND, "critical", details);
        } else if (over(drop, ours, DROP.warning)) {
          out.balance = "warning";
          await alert(DROP_KIND, "warning", details);
        } else {
          out.balance = "ok";
          await resolve(DROP_KIND);
        }
        Object.assign(set, sample);
      } else {
        out.balance = "window";
      }
    }
    const cols = Object.keys(set);
    await db.query(
      `UPDATE gpu_provider_account_watch
          SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated = now()
        WHERE id = $1`,
      [w.id, ...cols.map((c) => set[c])],
    );
    return out;
  });
}

// everything learned so far, except when the last answer came (which only
// moves forward, so no older answer lands after a newer one)
const CLEARED_READINGS = `rate_warning_passes = 0, rate_critical_passes = 0,
  last_balance_usd = NULL, last_expected_usd = NULL,
  baseline_at = NULL, baseline_balance_usd = NULL, baseline_expected_usd = NULL`;
// and that too: a new confirmation starts from nothing
const CLEARED_SAMPLES = `${CLEARED_READINGS}, last_asked_at = NULL`;

async function readWatch(identity: ProviderIdentity, db: Db = getPool()) {
  const { rows } = await db.query(
    `SELECT * FROM gpu_provider_account_watch
      WHERE provider = $1 AND provider_account_kind = $2 AND provider_account_id = $3`,
    [identity.provider, identity.kind, identity.id],
  );
  return rows[0];
}

async function lockWatch(db: Db, identity: ProviderIdentity) {
  const { rows } = await db.query(
    `SELECT * FROM gpu_provider_account_watch
      WHERE provider = $1 AND provider_account_kind = $2 AND provider_account_id = $3
      FOR UPDATE`,
    [identity.provider, identity.kind, identity.id],
  );
  return rows[0];
}

// The safety pause (the caller holds the live fence): until the owner resumes.
async function pauseKey(
  db: Db,
  credential_id: string,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE gpu_key_fences SET paused_reason = $2, paused_at = now(), updated = now()
      WHERE credential_id = $1 AND paused_reason IS NULL
        AND state IN ('active', 'draining')`,
    [credential_id, reason],
  );
}

// ---- the owner's confirmation and status ----

export type { GpuAccountChecks };

export interface GpuAccountWatchDeps {
  homeClient?: (account_id: string) => Promise<InterBayGpuApi | undefined>;
  freshAuth?: typeof requireDangerousSessionAuth;
  accountWriteFence?: typeof lockGpuAccountFence;
  isHomeBay?: (account_id: string) => Promise<boolean>;
}

function requireAccount(account_id: unknown): string {
  if (typeof account_id !== "string" || !isValidUUID(account_id)) {
    throw Error("Sign in to do this.");
  }
  return account_id;
}

async function connectedKey(
  account_id: string,
  db: Db,
): Promise<string | undefined> {
  const { rows } = await db.query(
    `SELECT id FROM external_credentials
      WHERE owner_account_id = $1 AND kind = $2 AND revoked IS NULL
      ORDER BY created DESC LIMIT 1`,
    [account_id, KEY_KIND],
  );
  return rows[0]?.id;
}

async function statusOf(account_id: string, db: Db): Promise<GpuAccountChecks> {
  const credential_id = await connectedKey(account_id, db);
  const none = { confirmed_at: null, last_checked_at: null };
  if (!credential_id) return { state: "no_key", ...none };
  const identity = await identityOf(credential_id, db);
  if (!identity) return { state: "off", ...none };
  const w = await readWatch(identity, db);
  if (
    !w?.confirmed_at ||
    w.credential_id !== credential_id ||
    w.key_owner_account_id !== account_id
  ) {
    return { state: "off", ...none };
  }
  const active = await identityCredentials(identity, db, { active: true });
  const iso = (d: any) => (d == null ? null : new Date(d).toISOString());
  return {
    state:
      active.length !== 1
        ? "shared"
        : w.disabled_reason === "no_access"
          ? "no_access"
          : "on",
    confirmed_at: iso(w.confirmed_at),
    last_checked_at: iso(w.last_asked_at),
  };
}

// On the key owner's home bay.
export async function getAccountChecksLocal(
  opts: { account_id?: string },
  deps: GpuAccountWatchDeps = {},
): Promise<GpuAccountChecks> {
  const account_id = requireAccount(opts.account_id);
  // the rows are only there: anywhere else this would quietly read "no key"
  await requireHomeBay(account_id, { isHomeBay: deps.isHomeBay });
  return await statusOf(account_id, getPool());
}

// On the key owner's home bay; the caller checked fresh authentication.
// confirm: the owner says the RunPod account of the connected key is used
// only by them, only for CoCalc (the checks start over); false withdraws it.
export async function confirmAccountChecksLocal(
  opts: {
    account_id?: string;
    confirm?: unknown;
    fresh_auth_verified?: boolean;
  },
  deps: GpuAccountWatchDeps = {},
): Promise<GpuAccountChecks> {
  const account_id = requireAccount(opts.account_id);
  if (opts.fresh_auth_verified !== true) {
    throw Object.assign(
      Error("Changing RunPod account checks needs you to sign in again."),
      { code: "fresh_auth_required" },
    );
  }
  if (typeof opts.confirm !== "boolean") {
    throw Error("Say whether to confirm (true) or withdraw (false).");
  }
  const confirm = opts.confirm;
  await requireHomeBay(account_id, { isHomeBay: deps.isHomeBay });
  return await inTransaction(async (db) => {
    await (deps.accountWriteFence ?? lockGpuAccountFence)(
      db,
      account_id,
      "change RunPod account checks",
    );
    const credential_id = await connectedKey(account_id, db);
    if (!credential_id) throw Error("No RunPod API key is connected.");
    const identity = await identityOf(credential_id, db);
    if (!identity) {
      throw Error(
        "CoCalc doesn't know which RunPod account this key belongs to; connect it again.",
      );
    }
    if (confirm) {
      // Another key's confirmation of the same account is replaced (the
      // checks then see two keys and stay off until one is gone): its
      // account alerts end with it.
      const prior = await lockWatch(db, identity);
      if (prior && prior.credential_id !== credential_id) {
        await endAccountAlerts(
          db,
          prior.credential_id,
          "confirmation_replaced",
          {
            terminal: false,
          },
        );
      }
      await db.query(
        `INSERT INTO gpu_provider_account_watch (id, provider, provider_account_kind,
           provider_account_id, key_owner_account_id, credential_id, confirmed_at,
           confirmation_id, updated)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7, now())
         ON CONFLICT (provider, provider_account_kind, provider_account_id)
         DO UPDATE SET key_owner_account_id = EXCLUDED.key_owner_account_id,
                       credential_id = EXCLUDED.credential_id,
                       confirmed_at = now(), disabled_reason = NULL,
                       confirmation_id = EXCLUDED.confirmation_id,
                       ${CLEARED_SAMPLES}, updated = now()`,
        [
          randomUUID(),
          identity.provider,
          identity.kind,
          identity.id,
          account_id,
          credential_id,
          randomUUID(),
        ],
      );
    } else {
      // (only a confirmation made with this key: never another owner's)
      await endAccountWatch(db, credential_id, "withdrawn", {
        terminal: false,
      });
    }
    log.debug("account checks", { account_id, confirm });
    return await statusOf(account_id, db);
  });
}

// On the bay the user is signed in to.
export async function getAccountChecks(
  opts: { account_id?: string },
  deps: GpuAccountWatchDeps = {},
): Promise<GpuAccountChecks> {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? budgetHomeClient)(account_id);
  if (home) return await home.gpuAccountChecks({ account_id });
  return await getAccountChecksLocal({ account_id });
}

// On the bay the user is signed in to: fresh authentication for the
// caller's own session, then the home bay does the rest.
export async function confirmAccountChecks(
  opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    confirm?: unknown;
  },
  deps: GpuAccountWatchDeps = {},
): Promise<GpuAccountChecks> {
  const account_id = requireAccount(opts.account_id);
  await (deps.freshAuth ?? requireDangerousSessionAuth)({
    account_id,
    browser_id: opts.browser_id,
    session_hash: opts.session_hash,
    require_second_factor: false,
  });
  const forwarded = {
    account_id,
    confirm: opts.confirm,
    fresh_auth_verified: true,
  };
  const home = await (deps.homeClient ?? budgetHomeClient)(account_id);
  if (home) return await home.gpuConfirmAccountChecks(forwarded);
  return await confirmAccountChecksLocal(forwarded, deps);
}
