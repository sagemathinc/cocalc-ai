/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import getPool from "@cocalc/database/pool";
import {
  applyProjectEventToAccountCollaboratorIndex,
  loadLatestCollaboratorProjectionEvent,
  retryAccountCollaboratorIndexDeadlock,
} from "@cocalc/database/postgres/account-collaborator-index-projector";
import { computeAccountProjectFeedEvents } from "@cocalc/database/postgres/account-project-index-projector";
import {
  loadProjectOutboxPayload,
  setProjectOutboxRemoteFeedEnabled,
  type ProjectOutboxPayload,
  type ProjectOutboxEventRow,
} from "@cocalc/database/postgres/project-events-outbox";
import getLogger from "@cocalc/backend/logger";
import {
  createInterBayAccountProjectFeedClient,
  type InterBayAccountProjectFeedApi,
} from "@cocalc/conat/inter-bay/api";
import type {
  AccountFeedEvent,
  AccountFeedProjectRemoveEvent,
  AccountFeedProjectRow,
  AccountFeedProjectUpsertEvent,
} from "@cocalc/conat/hub/api/account-feed";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { getClusterAccountsByIds } from "@cocalc/server/inter-bay/accounts";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { DEFAULT_BAY_ID } from "@cocalc/util/bay";
import { isValidUUID } from "@cocalc/util/misc";
import { publishAccountFeedEventBestEffort } from "./feed";

const logger = getLogger("server:account:project-feed");
const VISIBLE_PROJECT_GROUPS = new Set(["owner", "collaborator", "viewer"]);
type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

function parseDate(value: unknown): Date | null {
  if (value == null) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(`${value}`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function eventTimestampMs(value: unknown): number {
  return parseDate(value)?.getTime() ?? Date.now();
}

export function visibleAccountIdsFromUsers(
  users_summary: Record<string, any>,
): string[] {
  return Object.entries(users_summary ?? {})
    .filter(
      ([account_id, info]) =>
        isValidUUID(account_id) &&
        VISIBLE_PROJECT_GROUPS.has(`${info?.group ?? ""}`.trim()),
    )
    .map(([account_id]) => account_id);
}

function buildProjectFeedRow(opts: {
  payload: ProjectOutboxPayload;
}): AccountFeedProjectRow {
  const { payload } = opts;
  return {
    project_id: payload.project_id,
    title: payload.title ?? "",
    description: payload.description ?? "",
    theme: payload.theme ?? null,
    labels: payload.labels ?? {},
    host_id: payload.host_id ?? null,
    rootfs_image_id: payload.rootfs_image_id ?? null,
    owning_bay_id: `${payload.owning_bay_id ?? ""}`.trim() || DEFAULT_BAY_ID,
    manage_users_owner_only: payload.manage_users_owner_only ?? null,
    deletion_protection: payload.deletion_protection ?? null,
    users: payload.users_summary ?? {},
    state: payload.state_summary ?? {},
    last_active: payload.last_activity_by_account ?? {},
    last_edited: payload.last_edited_at ?? null,
    last_backup: payload.last_backup_at ?? null,
  };
}

async function loadLatestProjectOutboxEvent(opts: {
  db: Queryable;
  project_id: string;
}): Promise<ProjectOutboxEventRow | null> {
  const { rows } = await opts.db.query(
    `SELECT
       event_id,
       project_id,
       COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $2) AS owning_bay_id,
       event_type,
       payload_json,
       created_at,
       published_at,
       collaborator_index_pending,
       collaborator_index_published_at,
       remote_feed_pending,
       remote_feed_published_at
     FROM project_events_outbox
     WHERE project_id = $1
     ORDER BY created_at DESC, event_id DESC
     LIMIT 1`,
    [opts.project_id, DEFAULT_BAY_ID],
  );
  return rows[0] ?? null;
}

async function loadPreviousVisibleAccountIds(opts: {
  db: Queryable;
  event: Pick<ProjectOutboxEventRow, "project_id" | "event_id" | "created_at">;
}): Promise<string[]> {
  const { rows } = await opts.db.query(
    `SELECT payload_json
       FROM project_events_outbox
      WHERE project_id = $1
        AND event_id <> $2
        AND (created_at < $3 OR (created_at = $3 AND event_id::TEXT < $2::TEXT))
      ORDER BY created_at DESC, event_id DESC
      LIMIT 1`,
    [opts.event.project_id, opts.event.event_id, opts.event.created_at],
  );
  return visibleAccountIdsFromUsers(rows[0]?.payload_json?.users_summary ?? {});
}

/** Accounts that could see the project just before `event`. */
export async function previousVisibleAccountIdsBefore(opts: {
  db: Queryable;
  event: Pick<ProjectOutboxEventRow, "project_id" | "event_id" | "created_at">;
}): Promise<string[]> {
  return await loadPreviousVisibleAccountIds(opts);
}

function sortKeyForFeedProject(opts: {
  project: AccountFeedProjectRow;
  account_id: string;
  fallback: Date;
}): Date {
  return (
    parseDate(opts.project.last_active?.[opts.account_id]) ??
    parseDate(opts.project.last_edited) ??
    opts.fallback
  );
}

export async function applyAccountProjectFeedUpsertOnHomeBay(
  event: AccountFeedProjectUpsertEvent,
): Promise<void> {
  const updated_at = new Date(event.ts);
  const last_activity_at =
    parseDate(event.project.last_active?.[event.account_id]) ?? null;
  await getPool().query(
    `INSERT INTO account_project_index
      (account_id, project_id, owning_bay_id, host_id, rootfs_image_id, title, description,
        theme, labels, users_summary, state_summary, last_edited, last_backup, last_activity_at,
        last_opened_at, is_hidden, deletion_protection, sort_key, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9::JSONB, $10::JSONB, $11::JSONB, $12, $13, $14, NULL, $15, $16, $17, $18)
     ON CONFLICT (account_id, project_id)
     DO UPDATE SET
       owning_bay_id = EXCLUDED.owning_bay_id,
       host_id = EXCLUDED.host_id,
       rootfs_image_id = EXCLUDED.rootfs_image_id,
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       theme = EXCLUDED.theme,
       labels = EXCLUDED.labels,
       users_summary = EXCLUDED.users_summary,
       state_summary = EXCLUDED.state_summary,
       last_edited = EXCLUDED.last_edited,
       last_backup = EXCLUDED.last_backup,
       last_activity_at = EXCLUDED.last_activity_at,
       is_hidden = EXCLUDED.is_hidden,
       deletion_protection = EXCLUDED.deletion_protection,
       sort_key = EXCLUDED.sort_key,
       updated_at = EXCLUDED.updated_at`,
    [
      event.account_id,
      event.project.project_id,
      `${event.project.owning_bay_id ?? ""}`.trim() || DEFAULT_BAY_ID,
      event.project.host_id,
      event.project.rootfs_image_id ?? null,
      event.project.title ?? "",
      event.project.description ?? "",
      JSON.stringify(event.project.theme ?? {}),
      JSON.stringify(event.project.labels ?? {}),
      JSON.stringify(event.project.users ?? {}),
      JSON.stringify(event.project.state ?? {}),
      parseDate(event.project.last_edited) ?? null,
      parseDate(event.project.last_backup) ?? null,
      last_activity_at,
      !!event.project.users?.[event.account_id]?.hide,
      event.project.deletion_protection === true,
      sortKeyForFeedProject({
        project: event.project,
        account_id: event.account_id,
        fallback: updated_at,
      }),
      updated_at,
    ],
  );
  await publishAccountFeedEventBestEffort({
    account_id: event.account_id,
    event,
  });
}

export async function applyAccountProjectFeedRemoveOnHomeBay(
  event: AccountFeedProjectRemoveEvent,
): Promise<void> {
  await getPool().query(
    `DELETE FROM account_project_index
      WHERE account_id = $1
        AND project_id = $2`,
    [event.account_id, event.project_id],
  );
  await publishAccountFeedEventBestEffort({
    account_id: event.account_id,
    event,
  });
}

async function forwardRemoteProjectFeedEventsBestEffort(
  opts: Parameters<typeof forwardRemoteProjectFeedEvents>[0],
): Promise<void> {
  try {
    await forwardRemoteProjectFeedEvents(opts);
  } catch (err) {
    logger.warn("failed to forward remote project feed events", {
      project_id: opts.payload.project_id,
      err: `${err}`,
    });
  }
}

/**
 * Send a project's state to every other bay where an affected collaborator
 * is homed: an upsert for those who can see it, a removal for those who
 * could see it before. Tries every account, then throws if any failed, so a
 * durable caller retries instead of losing an update.
 */
export async function forwardRemoteProjectFeedEvents(opts: {
  bay_id: string;
  payload: ProjectOutboxPayload;
  previousVisibleAccountIds: string[];
  event_ts?: string | Date | number | null;
}): Promise<void> {
  if (!isMultiBayCluster()) {
    return;
  }
  const currentVisible = visibleAccountIdsFromUsers(opts.payload.users_summary);
  const impacted = [
    ...new Set([...currentVisible, ...opts.previousVisibleAccountIds]),
  ];
  if (impacted.length === 0) {
    return;
  }
  const accountEntries = await getClusterAccountsByIds(impacted);
  const byAccountId = new Map(
    accountEntries
      .filter((row) => isValidUUID(`${row.account_id ?? ""}`))
      .map((row) => [`${row.account_id}`, `${row.home_bay_id ?? ""}`.trim()]),
  );
  const currentVisibleSet = new Set(currentVisible);
  const fabric = getInterBayFabricClient();
  const remoteClients = new Map<string, InterBayAccountProjectFeedApi>();
  const ts = eventTimestampMs(opts.event_ts);
  const failures: string[] = [];
  for (const account_id of impacted) {
    const dest_bay = byAccountId.get(account_id);
    if (!dest_bay || dest_bay === opts.bay_id) {
      continue;
    }
    const client =
      remoteClients.get(dest_bay) ??
      createInterBayAccountProjectFeedClient({
        client: fabric,
        dest_bay,
      });
    remoteClients.set(dest_bay, client);
    try {
      if (opts.payload.deleted || !currentVisibleSet.has(account_id)) {
        await client.remove({
          type: "project.remove",
          ts,
          account_id,
          project_id: opts.payload.project_id,
          reason: "membership_removed",
        });
      } else {
        await client.upsert({
          type: "project.upsert",
          ts,
          account_id,
          project: buildProjectFeedRow({
            payload: opts.payload,
          }),
        });
      }
    } catch (err) {
      failures.push(`${account_id}@${dest_bay}: ${err}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `failed to forward project ${opts.payload.project_id} to ${failures.length} account(s): ${failures.slice(0, 3).join("; ")}`,
    );
  }
}

// Forwarding to other bays never blocks the caller: a mutation on the owning
// bay must not wait out a fabric reconnect (or a slow peer) just to refresh
// another bay's read projection. Each project has its own serial queue so its
// events reach other bays in order. Forwards waiting behind a stalled send are
// coalesced, because each one carries a full snapshot of the project: only
// the newest snapshot is sent, together with every account that may have lost
// visibility in between.
type RemoteFeedJob =
  | {
      kind: "forward";
      bay_id: string;
      payload: ProjectOutboxPayload;
      previousVisibleAccountIds: Set<string>;
      ts: number;
    }
  | { kind: "run"; run: () => Promise<void> };

const remoteFeedQueues = new Map<string, RemoteFeedJob[]>();
const remoteFeedDrains = new Map<string, Promise<void>>();

function enqueueRemoteFeedJob(project_id: string, job: RemoteFeedJob): void {
  const queue = remoteFeedQueues.get(project_id) ?? [];
  const tail = queue[queue.length - 1];
  if (job.kind === "forward" && tail?.kind === "forward") {
    for (const account_id of job.previousVisibleAccountIds) {
      tail.previousVisibleAccountIds.add(account_id);
    }
    if (job.ts >= tail.ts) {
      tail.payload = job.payload;
      tail.ts = job.ts;
      tail.bay_id = job.bay_id;
    }
  } else {
    queue.push(job);
  }
  remoteFeedQueues.set(project_id, queue);
  if (!remoteFeedDrains.has(project_id)) {
    remoteFeedDrains.set(project_id, drainRemoteFeedQueue(project_id));
  }
}

async function drainRemoteFeedQueue(project_id: string): Promise<void> {
  try {
    for (;;) {
      const job = remoteFeedQueues.get(project_id)?.shift();
      if (job == null) {
        return;
      }
      try {
        if (job.kind === "forward") {
          await forwardRemoteProjectFeedEventsBestEffort({
            bay_id: job.bay_id,
            payload: job.payload,
            previousVisibleAccountIds: [...job.previousVisibleAccountIds],
            event_ts: new Date(job.ts),
          });
        } else {
          await job.run();
        }
      } catch (err) {
        logger.warn("failed to forward project feed events to other bays", {
          project_id,
          err: `${err}`,
        });
      }
    }
  } finally {
    remoteFeedQueues.delete(project_id);
    remoteFeedDrains.delete(project_id);
  }
}

/** Resolves once every queued forward to other bays has been attempted. */
export async function flushRemoteProjectFeedForwards(): Promise<void> {
  while (remoteFeedDrains.size > 0) {
    await Promise.all([...remoteFeedDrains.values()]);
  }
}

export async function publishProjectRemoveFeedEventsBestEffort(opts: {
  project_id: string;
  account_ids: string[];
  default_bay_id?: string;
  event_ts?: string | Date | number | null;
}): Promise<void> {
  const bay_id =
    `${opts.default_bay_id ?? getConfiguredBayId()}`.trim() || DEFAULT_BAY_ID;
  const account_ids = [
    ...new Set(
      opts.account_ids.filter((account_id) =>
        isValidUUID(`${account_id ?? ""}`),
      ),
    ),
  ];
  const ts = eventTimestampMs(opts.event_ts);
  const eventFor = (account_id: string): AccountFeedProjectRemoveEvent => ({
    type: "project.remove",
    ts,
    account_id,
    project_id: opts.project_id,
    reason: "membership_removed",
  });
  if (!isMultiBayCluster()) {
    await Promise.all(
      account_ids.map((account_id) =>
        publishAccountFeedEventBestEffort({
          account_id,
          event: eventFor(account_id),
        }),
      ),
    );
    return;
  }
  const accountEntries = await getClusterAccountsByIds(account_ids);
  const homeBayByAccountId = new Map(
    accountEntries
      .filter((row) => isValidUUID(`${row.account_id ?? ""}`))
      .map((row) => [`${row.account_id}`, `${row.home_bay_id ?? ""}`.trim()]),
  );
  const remote: { account_id: string; dest_bay: string }[] = [];
  await Promise.all(
    account_ids.map(async (account_id) => {
      const dest_bay = homeBayByAccountId.get(account_id);
      if (!dest_bay || dest_bay === bay_id) {
        await publishAccountFeedEventBestEffort({
          account_id,
          event: eventFor(account_id),
        });
      } else {
        remote.push({ account_id, dest_bay });
      }
    }),
  );
  if (remote.length === 0) {
    return;
  }
  enqueueRemoteFeedJob(opts.project_id, {
    kind: "run",
    run: async () => {
      const fabric = getInterBayFabricClient();
      const remoteClients = new Map<string, InterBayAccountProjectFeedApi>();
      await Promise.all(
        remote.map(async ({ account_id, dest_bay }) => {
          const client =
            remoteClients.get(dest_bay) ??
            createInterBayAccountProjectFeedClient({
              client: fabric,
              dest_bay,
            });
          remoteClients.set(dest_bay, client);
          try {
            await client.remove(eventFor(account_id));
          } catch (err) {
            logger.warn("failed to forward remote project remove feed event", {
              project_id: opts.project_id,
              account_id,
              dest_bay,
              err: `${err}`,
            });
          }
        }),
      );
    },
  });
}

// Set by the durable forwarding loop (projections/project-feed-remote-maintenance).
let remoteDrainKick: (() => void) | undefined;

export function setRemoteProjectFeedDrainKick(
  kick: (() => void) | undefined,
): void {
  remoteDrainKick = kick;
}

export function enableDbProjectAccountFeedPublishing() {
  db().publishProjectAccountFeedEventsBestEffort =
    publishProjectAccountFeedEventsBestEffort;
  // Mark new outbox events for durable delivery to other bays.
  setProjectOutboxRemoteFeedEnabled(isMultiBayCluster());
}

export async function publishProjectAccountFeedEventsBestEffort(opts: {
  project_id: string;
  default_bay_id?: string;
}): Promise<void> {
  const bay_id =
    `${opts.default_bay_id ?? getConfiguredBayId()}`.trim() || DEFAULT_BAY_ID;
  const client = await getPool().connect();
  let events: AccountFeedEvent[] = [];
  let collaboratorFeedEvents: AccountFeedEvent[] = [];
  let payload: ProjectOutboxPayload | undefined;
  let previousVisibleAccountIds: string[] = [];
  let latestEvent: ProjectOutboxEventRow | null = null;
  try {
    latestEvent = await loadLatestProjectOutboxEvent({
      db: client,
      project_id: opts.project_id,
    });
    payload =
      latestEvent?.payload_json ??
      (await loadProjectOutboxPayload({
        db: client,
        project_id: opts.project_id,
        default_bay_id: bay_id,
      }));
    events = await computeAccountProjectFeedEvents({
      db: client,
      bay_id,
      payload,
      event_ts: latestEvent?.created_at,
    });
    previousVisibleAccountIds =
      latestEvent == null
        ? []
        : await loadPreviousVisibleAccountIds({
            db: client,
            event: latestEvent,
          });
    // Summary/state updates cannot change collaborator relationships. Do not
    // search membership history just to discard the result below.
    const collaboratorEvent =
      latestEvent != null &&
      [
        "project.created",
        "project.membership_changed",
        "project.deleted",
      ].includes(latestEvent.event_type)
        ? await loadLatestCollaboratorProjectionEvent({
            db: client,
            project_id: opts.project_id,
          })
        : null;
    if (
      collaboratorEvent != null &&
      collaboratorEvent.event_id === latestEvent?.event_id
    ) {
      const collaborator = await retryAccountCollaboratorIndexDeadlock(
        async () => {
          await client.query("BEGIN");
          try {
            const result = await applyProjectEventToAccountCollaboratorIndex({
              db: client,
              bay_id,
              event: collaboratorEvent,
            });
            await client.query("COMMIT");
            return result;
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          }
        },
      );
      collaboratorFeedEvents = collaborator.feed_events;
    }
  } finally {
    client.release();
  }
  for (const event of events) {
    await publishAccountFeedEventBestEffort({
      account_id: event.account_id,
      event,
    });
  }
  if (payload && isMultiBayCluster()) {
    const durable =
      latestEvent?.remote_feed_pending === true ||
      latestEvent?.remote_feed_published_at != null;
    if (durable && remoteDrainKick) {
      // The outbox row is the durable record; forward it now.
      remoteDrainKick();
    } else {
      // No pending outbox row (e.g. an event written before this bay
      // enabled durable forwarding): forward once, best effort.
      enqueueRemoteFeedJob(opts.project_id, {
        kind: "forward",
        bay_id,
        payload,
        previousVisibleAccountIds: new Set(previousVisibleAccountIds),
        ts: eventTimestampMs(latestEvent?.created_at),
      });
    }
  }
  for (const event of collaboratorFeedEvents) {
    await publishAccountFeedEventBestEffort({
      account_id: event.account_id,
      event,
    });
  }
}
