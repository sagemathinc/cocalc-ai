/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Catalog deltas (listChanges) and the change-hint drainer.
//
// listChanges: the hub validates the whole request (nothing that depends on
// the project), resolves the project's owner bay, and the owner bay
// authorizes before anything project-dependent, so an unreadable and a
// nonexistent project get the same refusal for any input.
//
// Hints: after a catalog change commits, the owner bay tells the readers
// with a live browser session that the project reached a version
// ({project, epoch, seq}, no metadata). Delivery follows the retained-target
// outbox in database/postgres/artifact-catalog-changes. Hints only reduce
// latency: readers repair from versions on reconnect, on tab-visible and
// with a visible-only probe whether or not hints arrive.

import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import * as metrics from "@cocalc/backend/metrics";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import type {
  ArtifactCatalogApi,
  CatalogChangesPage,
} from "@cocalc/conat/hub/api/artifact-catalog";
import type { AccountFeedEvent } from "@cocalc/conat/hub/api/account-feed";
import { createInterBayArtifactCatalogClient } from "@cocalc/conat/inter-bay/artifact-catalog";
import getPool from "@cocalc/database/pool";
import {
  ARTIFACT_CATALOG_HINT_MAX_ATTEMPTS,
  artifactCatalogHintRecipients,
  artifactCatalogHintsDue,
  claimArtifactCatalogHint,
  completeArtifactCatalogHint,
  failArtifactCatalogHint,
  readArtifactCatalogChangesForAccount,
  renewArtifactCatalogHint,
  validateArtifactCatalogChangesRequest,
  type ArtifactCatalogHintClaim,
} from "@cocalc/database/postgres/artifact-catalog-changes";
import {
  ARTIFACT_CATALOG_NOT_PERMITTED,
  authorizedArtifactCatalogProjects,
} from "@cocalc/database/postgres/artifact-catalog-read";
import { publishAccountFeedEvent } from "@cocalc/server/account/feed";
import {
  ensureAccountSecurityStateReady,
  isAccountBannedCached,
} from "@cocalc/server/accounts/security-state";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { listLiveBrowserSessionAccountIds } from "@cocalc/server/conat/api/browser-sessions-live";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { assertArtifactCatalogReaderNotBanned } from "./catalog-list";
import { withArtifactCatalogReadLimit } from "./catalog-read-limits";
import {
  artifactCatalogDeltasReady,
  setArtifactCatalogHintsRunning,
} from "./catalog-readiness";

const log = getLogger("artifacts:catalog-changes");

export const ARTIFACT_CATALOG_DELTAS_UNAVAILABLE =
  "artifact catalog deltas unavailable";

/** Hub entry point: validate, rate-limit, route to the project's owner bay. */
export const listChanges: ArtifactCatalogApi["listChanges"] = async (opts) => {
  requireUuid(opts?.account_id, "account_id");
  const account_id = opts.account_id!;
  // Only project-independent checks before routing (reveals nothing).
  const request = validateArtifactCatalogChangesRequest(opts);
  return await withArtifactCatalogReadLimit(
    account_id,
    "listChanges",
    async () => {
      const owner = await resolveProjectBay(request.project_id);
      if (!owner) throw Error(ARTIFACT_CATALOG_NOT_PERMITTED);
      const api =
        owner.bay_id === getConfiguredBayId()
          ? { listChanges: listChangesOwnedControl }
          : createInterBayArtifactCatalogClient({
              client: getInterBayFabricClient(),
              bay_id: owner.bay_id,
            });
      return await api.listChanges({ ...request, account_id });
    },
  );
};

/**
 * Trusted inter-bay entry on the owner bay. Authorization comes before
 * everything that depends on the project, including whether deltas are
 * served here; access is checked again after the read.
 */
export async function listChangesOwnedControl(opts: {
  account_id: string;
  project_id: string;
  from: { epoch: string; seq: number };
  through_seq?: number;
  after_entry?: string;
}): Promise<CatalogChangesPage> {
  requireUuid(opts?.account_id, "account_id");
  const account_id = opts.account_id;
  const request = validateArtifactCatalogChangesRequest(opts);
  const owning_bay_id = getConfiguredBayId();
  await assertArtifactCatalogReaderNotBanned(account_id);
  const readable = async () =>
    (
      await authorizedArtifactCatalogProjects(getPool(), {
        account_id,
        owning_bay_id,
        project_ids: [request.project_id],
      })
    ).has(request.project_id);
  if (!(await readable())) throw Error(ARTIFACT_CATALOG_NOT_PERMITTED);
  if (!(await artifactCatalogDeltasReady()))
    throw Error(ARTIFACT_CATALOG_DELTAS_UNAVAILABLE);
  const page = await readArtifactCatalogChangesForAccount({
    account_id,
    owning_bay_id,
    request,
  });
  if (!(await readable())) throw Error(ARTIFACT_CATALOG_NOT_PERMITTED);
  await assertArtifactCatalogReaderNotBanned(account_id);
  return page;
}

// --- hint delivery ---

const RECIPIENT_TIMEOUT_MS = 5_000;
const PARALLEL = 16;
const SCAN_INTERVAL_MS = 5_000;
const SCAN_PROJECTS = 100;
const LIVE_SESSION_MAX_AGE_MS = 3 * 60_000;
const LIVE_CACHE_MS = 5_000;

/** Seconds-scale backoff after the n-th failed attempt, with jitter. */
export function artifactCatalogHintBackoffMs(
  attempts: number,
  random = Math.random,
): number {
  const base = Math.min(2 ** attempts * 1000, 5 * 60_000);
  return Math.round(base * (0.8 + 0.4 * random()));
}

let live: { at: number; ids: Promise<string[]> } | undefined;

/** Accounts with a live browser session. A failed lookup throws: it is
 * never treated as "nobody to tell". */
async function liveSessionAccounts(): Promise<string[]> {
  const now = Date.now();
  if (!live || now - live.at > LIVE_CACHE_MS) {
    const ids = listLiveBrowserSessionAccountIds({
      max_age_ms: LIVE_SESSION_MAX_AGE_MS,
    }).then((ids) => {
      if (!Array.isArray(ids)) throw Error("live session lookup failed");
      return ids;
    });
    live = { at: now, ids };
    ids.catch(() => {
      if (live?.ids === ids) live = undefined;
    });
  }
  return await live.ids;
}

export interface HintDeps {
  owning_bay_id: string;
  liveAccounts: () => Promise<string[]>;
  recipients: typeof artifactCatalogHintRecipients;
  banned: (account_id: string) => Promise<boolean>;
  publish: (account_id: string, event: AccountFeedEvent) => Promise<void>;
  claim: typeof claimArtifactCatalogHint;
  renew: typeof renewArtifactCatalogHint;
  complete: typeof completeArtifactCatalogHint;
  fail: typeof failArtifactCatalogHint;
  now: () => number;
}

const defaultDeps = (): HintDeps => ({
  owning_bay_id: getConfiguredBayId(),
  liveAccounts: liveSessionAccounts,
  recipients: artifactCatalogHintRecipients,
  banned: async (account_id) => {
    await ensureAccountSecurityStateReady();
    return isAccountBannedCached(account_id);
  },
  // The throwing publisher: only the durable stream publish counts.
  publish: (account_id, event) =>
    publishAccountFeedEvent({ account_id, event }),
  claim: claimArtifactCatalogHint,
  renew: renewArtifactCatalogHint,
  complete: completeArtifactCatalogHint,
  fail: failArtifactCatalogHint,
  now: Date.now,
});

let undeliverable: any;
function countUndeliverable() {
  undeliverable ??= metrics.newCounter(
    "server",
    "artifact_catalog_hints_undeliverable_total",
    "Artifact catalog change hints given up after repeated delivery failures.",
  );
  undeliverable.inc();
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("hint publish timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type HintOutcome = "none" | "delivered" | "failed" | "gave-up" | "lost";

async function failOrGiveUp(
  deps: HintDeps,
  claim: ArtifactCatalogHintClaim,
): Promise<HintOutcome> {
  if (claim.attempts + 1 >= ARTIFACT_CATALOG_HINT_MAX_ATTEMPTS) {
    if (await deps.complete(claim)) {
      countUndeliverable();
      log.warn("artifact hints undeliverable");
      return "gave-up";
    }
    return "lost";
  }
  return (await deps.fail(
    claim,
    artifactCatalogHintBackoffMs(claim.attempts + 1),
  ))
    ? "failed"
    : "lost";
}

/**
 * Claims one project's delivery and publishes its hint to every current
 * reader with a live session. Success only when every recipient's publish
 * succeeded (or there was, verifiably, nobody to tell); a failed lookup,
 * query or publish keeps the target for a later retry.
 */
export async function deliverArtifactCatalogHint(
  project_id: string,
  deps: HintDeps = defaultDeps(),
): Promise<HintOutcome> {
  const claim = await deps.claim(project_id, randomUUID());
  if (!claim) return "none";
  if (claim.attempts >= ARTIFACT_CATALOG_HINT_MAX_ATTEMPTS) {
    // Repeated crash takeovers: give up without publishing.
    if (await deps.complete(claim)) {
      countUndeliverable();
      log.warn("artifact hints undeliverable");
      return "gave-up";
    }
    return "lost";
  }
  let recipients: string[];
  try {
    const candidates = await deps.liveAccounts();
    const allowed = await deps.recipients({
      project_id,
      owning_bay_id: deps.owning_bay_id,
      candidates,
    });
    recipients = [];
    for (const account_id of allowed)
      if (!(await deps.banned(account_id))) recipients.push(account_id);
  } catch {
    return await failOrGiveUp(deps, claim);
  }
  const event = (account_id: string): AccountFeedEvent => ({
    type: "artifact.changed",
    ts: deps.now(),
    account_id,
    project_id,
    epoch: claim.epoch,
    seq: claim.target_seq,
  });
  for (let i = 0; i < recipients.length; i += PARALLEL) {
    if (i > 0 && !(await deps.renew(claim))) return "lost";
    const batch = recipients.slice(i, i + PARALLEL);
    const results = await Promise.allSettled(
      batch.map((account_id) =>
        withTimeout(
          deps.publish(account_id, event(account_id)),
          RECIPIENT_TIMEOUT_MS,
        ),
      ),
    );
    if (results.some((result) => result.status === "rejected"))
      return await failOrGiveUp(deps, claim);
  }
  return (await deps.complete(claim)) ? "delivered" : "lost";
}

let stopDrainer: (() => void) | undefined;
let nudged: (() => void) | undefined;

/** Asks the drainer to look for due hints now (after a committed change). */
export function nudgeArtifactCatalogHints(): void {
  nudged?.();
}

/**
 * Runs on each bay: delivers due hints after a nudge, and scans for due
 * hints every few seconds (a lost nudge, a retry that came due).
 */
export function startArtifactCatalogHintDrainer(): () => void {
  if (stopDrainer) return stopDrainer;
  let stopped = false;
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    clearTimeout(timer);
    try {
      do {
        again = false;
        const due = await artifactCatalogHintsDue({
          owning_bay_id: getConfiguredBayId(),
          limit: SCAN_PROJECTS,
        });
        for (const project_id of due) {
          if (stopped) break;
          await deliverArtifactCatalogHint(project_id).catch((error) =>
            log.warn("artifact hint delivery failed", { error: `${error}` }),
          );
        }
      } while (again && !stopped);
    } catch (error) {
      log.warn("artifact hint scan failed", { error: `${error}` });
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
        timer.unref?.();
      }
    }
  };
  nudged = () => void tick();
  timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
  timer.unref?.();
  setArtifactCatalogHintsRunning(true);
  stopDrainer = () => {
    stopped = true;
    clearTimeout(timer);
    nudged = undefined;
    stopDrainer = undefined;
    setArtifactCatalogHintsRunning(false);
  };
  return stopDrainer;
}
