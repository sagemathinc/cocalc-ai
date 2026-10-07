/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Durable delivery of project changes to other bays' project lists.
//
// On a multi-bay cluster a project's collaborators may be homed on other
// bays, which list the project from their own account_project_index. Every
// project change appends a project_events_outbox row in the same transaction
// as the change; on a multi-bay cluster that row is marked
// remote_feed_pending. This loop, on the owning bay, forwards pending events
// until every other bay has them: a failure or a hub restart only delays
// delivery. Each event carries a full project snapshot, so a project's
// pending events are forwarded together as their newest snapshot, plus a
// removal for every account that could see an earlier state but not the
// newest one.

import getLogger from "@cocalc/backend/logger";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import type { ProjectOutboxPayload } from "@cocalc/database/postgres/project-events-outbox";
import {
  forwardRemoteProjectFeedEvents,
  previousVisibleAccountIdsBefore,
  setRemoteProjectFeedDrainKick,
  visibleAccountIdsFromUsers,
} from "@cocalc/server/account/project-feed";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { DEFAULT_BAY_ID } from "@cocalc/util/bay";

const logger = getLogger("server:projections:project-feed-remote");

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

const INTERVAL_MS = clampInt(
  process.env.COCALC_PROJECT_FEED_REMOTE_INTERVAL_MS,
  2_000,
  100,
  10 * 60_000,
);
const PROJECTS_PER_TICK = clampInt(
  process.env.COCALC_PROJECT_FEED_REMOTE_PROJECTS_PER_TICK,
  50,
  1,
  10_000,
);
const CONCURRENCY = clampInt(
  process.env.COCALC_PROJECT_FEED_REMOTE_CONCURRENCY,
  8,
  1,
  64,
);
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export function remoteFeedBackoffMs(attempts: number): number {
  return Math.min(
    MAX_BACKOFF_MS,
    MIN_BACKOFF_MS * 2 ** Math.max(0, Math.min(attempts, 20)),
  );
}

interface ClaimedEvent {
  event_id: string;
  project_id: string;
  created_at: Date;
  payload_json: ProjectOutboxPayload;
  remote_feed_attempts: number;
}

export interface ProjectFeedRemotePassResult {
  bay_id: string;
  projects: number;
  forwarded_projects: number;
  failed_projects: number;
  events: number;
}

function projectLockKey(project_id: string): string {
  return `project-feed-remote:${project_id}`;
}

/**
 * Load one project's pending events while holding its session lock, unless
 * one of them is backing off, so its snapshots can never overtake each other.
 * The lock is held by `client` until the forward finishes; if the hub dies it
 * goes with the connection, so another process can retry right away.
 */
async function loadProjectEvents(
  client: PoolClient,
  project_id: string,
): Promise<ClaimedEvent[] | null> {
  const { rows } = await client.query<ClaimedEvent & { backing_off: boolean }>(
    `SELECT event_id, project_id, created_at, payload_json,
            remote_feed_attempts,
            COALESCE(remote_feed_next_attempt_at > NOW(), FALSE) AS backing_off
       FROM project_events_outbox
      WHERE project_id = $1
        AND remote_feed_pending
      ORDER BY created_at ASC, event_id ASC`,
    [project_id],
  );
  if (rows.length === 0 || rows.some((row) => row.backing_off)) return null;
  return rows;
}

async function withProjectLock<T>(
  project_id: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T | undefined> {
  const client = await getPool().connect();
  let locked = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [projectLockKey(project_id)],
    );
    locked = rows[0]?.locked === true;
    if (!locked) return undefined;
    return await fn(client);
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [
          projectLockKey(project_id),
        ])
        .catch(() => undefined);
    }
    client.release();
  }
}

async function finishProject(
  events: ClaimedEvent[],
  err?: unknown,
): Promise<void> {
  const ids = events.map((event) => event.event_id);
  if (err == null) {
    await getPool().query(
      `UPDATE project_events_outbox
          SET remote_feed_pending = FALSE,
              remote_feed_published_at = NOW(),
              remote_feed_next_attempt_at = NULL,
              remote_feed_last_error = NULL
        WHERE event_id = ANY($1::UUID[])`,
      [ids],
    );
    return;
  }
  const attempts = Math.max(
    ...events.map((event) => event.remote_feed_attempts ?? 0),
  );
  await getPool().query(
    `UPDATE project_events_outbox
        SET remote_feed_attempts = remote_feed_attempts + 1,
            remote_feed_next_attempt_at = NOW() + ($2::BIGINT * INTERVAL '1 millisecond'),
            remote_feed_last_error = $3
      WHERE event_id = ANY($1::UUID[])`,
    [ids, remoteFeedBackoffMs(attempts), `${err}`.slice(0, 1000)],
  );
}

async function forwardProject(
  bay_id: string,
  events: ClaimedEvent[],
): Promise<void> {
  const newest = events[events.length - 1];
  // Everyone who could see the project before these events, or at any
  // intermediate state, must get the newest state: an upsert if they can
  // still see it, otherwise a removal.
  const previous = new Set(
    await previousVisibleAccountIdsBefore({
      db: getPool(),
      event: events[0],
    }),
  );
  for (const event of events.slice(0, -1)) {
    for (const account_id of visibleAccountIdsFromUsers(
      event.payload_json?.users_summary ?? {},
    )) {
      previous.add(account_id);
    }
  }
  await forwardRemoteProjectFeedEvents({
    bay_id,
    payload: newest.payload_json,
    previousVisibleAccountIds: [...previous],
    event_ts: newest.created_at,
  });
}

type ProjectOutcome =
  { outcome: "forwarded" | "failed"; events: number } | { outcome: "skipped" };

async function forwardOneProject(
  bay_id: string,
  project_id: string,
): Promise<ProjectOutcome> {
  const outcome = await withProjectLock(
    project_id,
    async (client): Promise<ProjectOutcome> => {
      const events = await loadProjectEvents(client, project_id);
      if (events == null) return { outcome: "skipped" };
      try {
        await forwardProject(bay_id, events);
        await finishProject(events);
        return { outcome: "forwarded", events: events.length };
      } catch (err) {
        logger.warn(
          "forwarding project changes to other bays failed; will retry",
          {
            project_id,
            events: events.length,
            attempts: events[events.length - 1].remote_feed_attempts + 1,
            err: `${err}`,
          },
        );
        await finishProject(events, err);
        return { outcome: "failed", events: events.length };
      }
    },
  );
  return outcome ?? { outcome: "skipped" };
}

// One forward per project at a time in this process. A change that arrives
// while its project is being forwarded is picked up as soon as that ends.
const inFlight = new Map<string, Promise<ProjectOutcome>>();
const dirty = new Set<string>();

function driveProject(
  bay_id: string,
  project_id: string,
): Promise<ProjectOutcome> {
  const current = inFlight.get(project_id);
  if (current != null) {
    dirty.add(project_id);
    return current.then(() => ({ outcome: "skipped" }) as ProjectOutcome);
  }
  const run = (async () => {
    let outcome: ProjectOutcome;
    do {
      dirty.delete(project_id);
      outcome = await forwardOneProject(bay_id, project_id);
    } while (dirty.has(project_id) && outcome.outcome === "forwarded");
    return outcome;
  })().finally(() => {
    inFlight.delete(project_id);
    dirty.delete(project_id);
  });
  inFlight.set(project_id, run);
  return run;
}

export async function runProjectFeedRemotePass(opts?: {
  bay_id?: string;
  limit?: number;
}): Promise<ProjectFeedRemotePassResult> {
  const bay_id =
    `${opts?.bay_id ?? getConfiguredBayId()}`.trim() || DEFAULT_BAY_ID;
  const result: ProjectFeedRemotePassResult = {
    bay_id,
    projects: 0,
    forwarded_projects: 0,
    failed_projects: 0,
    events: 0,
  };
  const { rows } = await getPool().query<{ project_id: string }>(
    `SELECT project_id
       FROM project_events_outbox
      WHERE remote_feed_pending
        AND (remote_feed_next_attempt_at IS NULL OR remote_feed_next_attempt_at <= NOW())
      GROUP BY project_id
      ORDER BY MIN(created_at)
      LIMIT $1`,
    [opts?.limit ?? PROJECTS_PER_TICK],
  );
  // Projects are independent, so a slow bay holds up only its own projects.
  const queue = rows.map((row) => row.project_id);
  const worker = async () => {
    for (;;) {
      const project_id = queue.shift();
      if (project_id == null) return;
      const outcome = await driveProject(bay_id, project_id);
      if (outcome.outcome === "skipped") continue;
      result.projects += 1;
      result.events += outcome.events;
      if (outcome.outcome === "forwarded") {
        result.forwarded_projects += 1;
      } else {
        result.failed_projects += 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
  );
  return result;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await runProjectFeedRemotePass();
    if (result.failed_projects > 0) {
      logger.info("project feed forwarding pass", result);
    }
  } catch (err) {
    logger.warn("project feed forwarding pass failed", { err: `${err}` });
  } finally {
    running = false;
  }
}

/** Forward a project's changes now: called right after a change on this bay. */
export function kickProjectFeedRemoteDrain(project_id: string): void {
  if (!timer) return;
  driveProject(getConfiguredBayId(), project_id).catch((err) =>
    logger.warn("project feed forwarding failed", {
      project_id,
      err: `${err}`,
    }),
  );
}

export function startProjectFeedRemoteMaintenance(): void {
  if (!isMultiBayCluster()) return;
  if (timer) return;
  timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref?.();
  setRemoteProjectFeedDrainKick(kickProjectFeedRemoteDrain);
  void tick();
  logger.info("project feed forwarding to other bays started", {
    interval_ms: INTERVAL_MS,
    projects_per_tick: PROJECTS_PER_TICK,
    concurrency: CONCURRENCY,
  });
}

export function stopProjectFeedRemoteMaintenance(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
  setRemoteProjectFeedDrainKick(undefined);
}
