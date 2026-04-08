/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import getPool from "@cocalc/database/pool";
import {
  applyProjectEventToAccountCollaboratorIndex,
  loadLatestCollaboratorProjectionEvent,
} from "@cocalc/database/postgres/account-collaborator-index-projector";
import { computeAccountProjectFeedEvents } from "@cocalc/database/postgres/account-project-index-projector";
import {
  loadProjectOutboxPayload,
  type ProjectOutboxPayload,
  type ProjectOutboxEventRow,
} from "@cocalc/database/postgres/project-events-outbox";
import getLogger from "@cocalc/backend/logger";
import {
  createInterBayAccountProjectFeedClient,
  type InterBayAccountProjectFeedApi,
} from "@cocalc/conat/inter-bay/api";
import type {
  AccountFeedProjectRemoveEvent,
  AccountFeedProjectRow,
  AccountFeedProjectUpsertEvent,
} from "@cocalc/conat/hub/api/account-feed";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { getClusterAccountsByIds } from "@cocalc/server/inter-bay/accounts";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { isValidUUID } from "@cocalc/util/misc";
import { publishAccountFeedEventBestEffort } from "./feed";

const logger = getLogger("server:account:project-feed");
const VISIBLE_PROJECT_GROUPS = new Set(["owner", "collaborator"]);
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

function visibleAccountIdsFromUsers(
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
  account_id: string;
}): AccountFeedProjectRow {
  const { payload, account_id } = opts;
  return {
    project_id: payload.project_id,
    title: payload.title ?? "",
    description: payload.description ?? "",
    name: payload.name ?? null,
    theme: payload.theme ?? null,
    host_id: payload.host_id ?? null,
    owning_bay_id: `${payload.owning_bay_id ?? ""}`.trim() || "bay-0",
    users: payload.users_summary ?? {},
    state: payload.state_summary ?? {},
    last_active: payload.last_activity_by_account ?? {},
    last_edited: payload.last_edited_at ?? null,
    deleted:
      !!payload.deleted ||
      !VISIBLE_PROJECT_GROUPS.has(
        `${payload.users_summary?.[account_id]?.group ?? ""}`.trim(),
      ),
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
       COALESCE(NULLIF(BTRIM(owning_bay_id), ''), 'bay-0') AS owning_bay_id,
       event_type,
       payload_json,
       created_at,
       published_at
     FROM project_events_outbox
     WHERE project_id = $1
     ORDER BY created_at DESC, event_id DESC
     LIMIT 1`,
    [opts.project_id],
  );
  return rows[0] ?? null;
}

async function loadPreviousVisibleAccountIds(opts: {
  db: Queryable;
  event: ProjectOutboxEventRow;
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
  if (event.project.deleted) {
    await applyAccountProjectFeedRemoveOnHomeBay({
      type: "project.remove",
      ts: event.ts,
      account_id: event.account_id,
      project_id: event.project.project_id,
      reason: "membership_removed",
    });
    return;
  }
  const updated_at = new Date(event.ts);
  const last_activity_at =
    parseDate(event.project.last_active?.[event.account_id]) ?? null;
  await getPool().query(
    `INSERT INTO account_project_index
       (account_id, project_id, owning_bay_id, host_id, title, description,
        theme, users_summary, state_summary, last_activity_at, last_opened_at,
        is_hidden, sort_key, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7::JSONB, $8::JSONB, $9::JSONB, $10, NULL, $11, $12, $13)
     ON CONFLICT (account_id, project_id)
     DO UPDATE SET
       owning_bay_id = EXCLUDED.owning_bay_id,
       host_id = EXCLUDED.host_id,
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       theme = EXCLUDED.theme,
       users_summary = EXCLUDED.users_summary,
       state_summary = EXCLUDED.state_summary,
       last_activity_at = EXCLUDED.last_activity_at,
       is_hidden = EXCLUDED.is_hidden,
       sort_key = EXCLUDED.sort_key,
       updated_at = EXCLUDED.updated_at`,
    [
      event.account_id,
      event.project.project_id,
      `${event.project.owning_bay_id ?? ""}`.trim() || "bay-0",
      event.project.host_id,
      event.project.title ?? "",
      event.project.description ?? "",
      JSON.stringify(event.project.theme ?? {}),
      JSON.stringify(event.project.users ?? {}),
      JSON.stringify(event.project.state ?? {}),
      last_activity_at,
      !!event.project.users?.[event.account_id]?.hide,
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

async function forwardRemoteProjectFeedEventsBestEffort(opts: {
  db: Queryable;
  bay_id: string;
  payload: ProjectOutboxPayload;
  latestEvent: ProjectOutboxEventRow | null;
}): Promise<void> {
  if (!isMultiBayCluster()) {
    return;
  }
  const currentVisible = visibleAccountIdsFromUsers(opts.payload.users_summary);
  const previousVisible =
    opts.latestEvent == null
      ? []
      : await loadPreviousVisibleAccountIds({
          db: opts.db,
          event: opts.latestEvent,
        });
  const impacted = [...new Set([...currentVisible, ...previousVisible])];
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
  const ts = Date.now();
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
            account_id,
          }),
        });
      }
    } catch (err) {
      logger.warn("failed to forward remote project feed event", {
        project_id: opts.payload.project_id,
        account_id,
        dest_bay,
        err: `${err}`,
      });
    }
  }
}

export function enableDbProjectAccountFeedPublishing() {
  db().publishProjectAccountFeedEventsBestEffort =
    publishProjectAccountFeedEventsBestEffort;
}

export async function publishProjectAccountFeedEventsBestEffort(opts: {
  project_id: string;
  default_bay_id?: string;
}): Promise<void> {
  const bay_id =
    `${opts.default_bay_id ?? getConfiguredBayId()}`.trim() || "bay-0";
  const client = await getPool().connect();
  try {
    const latestEvent = await loadLatestProjectOutboxEvent({
      db: client,
      project_id: opts.project_id,
    });
    const payload =
      latestEvent?.payload_json ??
      (await loadProjectOutboxPayload({
        db: client,
        project_id: opts.project_id,
        default_bay_id: bay_id,
      }));
    const events = await computeAccountProjectFeedEvents({
      db: client,
      bay_id,
      payload,
    });
    for (const event of events) {
      await publishAccountFeedEventBestEffort({
        account_id: event.account_id,
        event,
      });
    }
    await forwardRemoteProjectFeedEventsBestEffort({
      db: client,
      bay_id,
      payload,
      latestEvent,
    });
    const latestRows = await client.query<
      Pick<ProjectOutboxEventRow, "event_id">
    >(
      `SELECT event_id
         FROM project_events_outbox
        WHERE project_id = $1
        ORDER BY created_at DESC, event_id DESC
        LIMIT 1`,
      [opts.project_id],
    );
    const collaboratorEvent = await loadLatestCollaboratorProjectionEvent({
      db: client,
      project_id: opts.project_id,
    });
    if (
      collaboratorEvent != null &&
      collaboratorEvent.event_id === latestRows.rows[0]?.event_id
    ) {
      const collaborator = await applyProjectEventToAccountCollaboratorIndex({
        db: client,
        bay_id,
        event: collaboratorEvent,
      });
      for (const event of collaborator.feed_events) {
        await publishAccountFeedEventBestEffort({
          account_id: event.account_id,
          event,
        });
      }
    }
  } finally {
    client.release();
  }
}
