/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash, randomUUID } from "node:crypto";
import { ownerParticipation } from "./collaborators-relations-projection";
import { uuidsha1 } from "@cocalc/util/misc";
import getPool from "../../pool";
import type { PoolClient } from "../../pool";
import { withAccountRehomeWriteFence } from "../account-rehome-fence";
import {
  assertProjectNotRehoming,
  ProjectRehomeInProgressError,
} from "../project-rehome-fence";
import { syncSchema } from "../schema";
import { SCHEMA } from "@cocalc/util/schema";
import {
  collaborationAccountId,
  collaborationActivity,
  reconcileCollaborationAttention,
  validateCollaborationMessageEvent,
  validateCollaborationNotificationAttention,
} from "@cocalc/util/collaboration-attention";
import type {
  CollaborationNotificationDelivery,
  CollaborationAttentionState,
  CollaborationNotificationEntry,
  CollaborationNotificationObligation,
  CollaborationNotificationReceiptQuery,
  LegacyCollaborationAttention,
} from "@cocalc/util/collaboration-attention";
import type {
  CollaborationResource,
  CollaborationSourceSnapshot,
} from "@cocalc/util/collaborators";

const MAX_PROJECT_EVENTS = 100_000;
const MAX_INGEST_EVENTS = 1000;
const MAX_INGEST_BYTES = 2 * 1024 * 1024;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const member = (value: unknown) =>
  value === "owner" || value === "collaborator";
const entryKey = (project_id: string, thread_id: string) =>
  hash(JSON.stringify([project_id, "conversation", thread_id]));

/** No event content or membership grant: confirm only exact outstanding IDs.
 * Do not reuse the delivery authorization lookup: temporary room/resource
 * unavailability is not proof that an obligation has irreversibly settled.
 */
export async function pendingNotificationReceipts(
  input: CollaborationNotificationReceiptQuery,
  authority: { owning_bay_id: string },
): Promise<string[]> {
  collaborationAccountId(input.project_id);
  collaborationAccountId(input.account_id);
  if (!Array.isArray(input.obligation_ids) || input.obligation_ids.length > 100)
    throw Error("invalid notification receipt batch");
  input.obligation_ids.forEach(collaborationAccountId);
  return transaction(async (db) => {
    await assertProjectNotRehoming({
      db,
      project_id: input.project_id,
      action: "inspect notification settlement",
    });
    const project = await db.query(
      "SELECT project_id FROM projects WHERE project_id=$1 AND owning_bay_id=$2 FOR SHARE",
      [input.project_id, authority.owning_bay_id],
    );
    if (!project.rows.length)
      throw Error("notification project owner unavailable");
    return (
      await db.query(
        "SELECT id FROM collaboration_notification_recipients WHERE project_id=$1 AND account_id=$2 AND id=ANY($3::uuid[])",
        [input.project_id, input.account_id, input.obligation_ids],
      )
    ).rows.map((r) => r.id);
  });
}

async function transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

/** Call after the collaborators schema exists and before enabling its maintenance.
 * The event log stores recoverable content-free intent, NOT another notification
 * feed. Only the existing notification graph/outbox creates user notifications.
 */
export async function ensureCollaborationNotificationSchema() {
  await syncSchema(
    Object.fromEntries(
      [
        "collaboration_notification_events",
        "collaboration_notification_recipients",
        "collaboration_notification_floors",
        "collaboration_notification_delivery_budget",
        "collaboration_notification_summary",
        "collaboration_notification_summary_receipts",
        "collaboration_notification_subscriptions",
        "collaboration_personal",
      ].map((table) => {
        if (!SCHEMA[table])
          throw Error(`missing collaboration schema: ${table}`);
        return [table, SCHEMA[table]];
      }),
    ),
  );
}

/** Ingest callback: MUST run inside ingestCollaborationSnapshot's transaction,
 * after owner/host/epoch validation, including when resource metadata is unchanged.
 * The source journal supplies only new immutable message facts in notification_events.
 * A source scan must never infer live events from pre-existing history.
 */
export async function appendCollaborationNotificationEvents(
  db: PoolClient,
  snapshot: CollaborationSourceSnapshot,
  authority: { owning_bay_id: string; host_id: string },
): Promise<void> {
  const input = snapshot.notification_events ?? [];
  if (
    !Array.isArray(input) ||
    input.length > MAX_INGEST_EVENTS ||
    Buffer.byteLength(JSON.stringify(input)) > MAX_INGEST_BYTES
  )
    throw Error("collaboration notification ingest exceeds capacity");
  if (!input.length) return;
  const events = input.map(validateCollaborationMessageEvent);
  await assertProjectNotRehoming({
    db,
    project_id: snapshot.project_id,
    action: "append collaboration notifications",
  });
  // Per-project serialization prevents a later committed position from overtaking
  // an earlier uncommitted one and creating a gap in recipient event cursors.
  const project = (
    await db.query(
      `SELECT p.users,p.deleted,p.host_id,c.generation FROM projects p
     JOIN collaboration_projects c USING(project_id)
     WHERE p.project_id=$1 AND p.owning_bay_id=$2 FOR UPDATE OF p,c`,
      [snapshot.project_id, authority.owning_bay_id],
    )
  ).rows[0];
  if (!project || project.deleted || project.host_id !== authority.host_id)
    throw Error("collaboration notification writer unavailable");
  const source = (
    await db.query(
      "SELECT epoch,writer_host_id FROM collaboration_sources WHERE project_id=$1 AND chat_path=$2",
      [snapshot.project_id, snapshot.chat_path],
    )
  ).rows[0];
  if (
    source?.epoch !== snapshot.epoch ||
    source?.writer_host_id !== authority.host_id
  )
    throw Error("stale collaboration notification writer");
  // Establish existing members before the first live event. True joins/rejoins
  // are captured by the project membership trigger even between worker polls.
  await db.query(
    `INSERT INTO collaboration_memberships(project_id,account_id,epoch,notification_position)
     SELECT $1,u.key::uuid,gen_random_uuid(),GREATEST(
       COALESCE((SELECT max(position) FROM collaboration_notification_events WHERE project_id=$1),0),
       COALESCE((SELECT position FROM collaboration_notification_floors WHERE project_id=$1),0))
     FROM jsonb_each($2::jsonb) u WHERE u.value->>'group' IN ('owner','collaborator')
     ON CONFLICT(project_id,account_id) DO NOTHING`,
    [snapshot.project_id, JSON.stringify(project.users ?? {})],
  );
  const room = (
    await db.query(
      "SELECT room_id,chat_path FROM collaboration_rooms WHERE project_id=$1",
      [snapshot.project_id],
    )
  ).rows[0];
  let count = Number(
    (
      await db.query(
        "SELECT count(*) AS n FROM collaboration_notification_events WHERE project_id=$1",
        [snapshot.project_id],
      )
    ).rows[0].n,
  );
  for (const event of events) {
    if (
      event.project_id !== snapshot.project_id ||
      room?.room_id !== event.room_id ||
      room?.chat_path !== snapshot.chat_path ||
      !snapshot.resources.some(
        (r) =>
          r.kind === "conversation" &&
          r.thread_id === event.thread_id &&
          r.activity >= event.activity,
      )
    )
      throw Error(
        "notification event does not belong to canonical human source",
      );
    if (
      event.mode !== "live" ||
      !member(project.users?.[event.actor_account_id]?.group)
    )
      continue;
    const id = uuidsha1(
      JSON.stringify([
        event.project_id,
        event.room_id,
        event.thread_id,
        event.message_id,
      ]),
    );
    const event_json = JSON.stringify(event);
    const event_hash = hash(event_json);
    const previous = (
      await db.query(
        "SELECT event_hash FROM collaboration_notification_events WHERE event_id=$1",
        [id],
      )
    ).rows[0];
    if (previous) {
      if (previous.event_hash !== event_hash)
        throw Error("collaboration message event changed on replay");
      continue;
    }
    if (++count > MAX_PROJECT_EVENTS)
      throw Error(
        "collaboration notification event log capacity reached; retry after maintenance",
      );
    // Positions are project-local cursors. A rehomed project's retained positions
    // may be ahead of this bay's sequence; never place new intent behind them.
    await db.query(
      `INSERT INTO collaboration_notification_events(event_id,project_id,generation,event_json,event_hash,mention_all_allowed,fanout_pending,fanout_due,position)
       VALUES($1,$2,$3,$4::jsonb,$5,$6,true,now(),GREATEST(
         COALESCE((SELECT max(position) FROM collaboration_notification_events WHERE project_id=$2),0),
         COALESCE((SELECT position FROM collaboration_notification_floors WHERE project_id=$2),0))+1)`,
      [
        id,
        event.project_id,
        project.generation,
        event_json,
        event_hash,
        event.mention_all &&
          project.users[event.actor_account_id].group === "owner",
      ],
    );
    await db.query(
      `UPDATE collaboration_projects SET
        notification_due=LEAST(notification_due,clock_timestamp()) WHERE project_id=$1`,
      [event.project_id],
    );
  }
}

/** Caller holds the authoritative project lock and has checked this recipient.
 * The membership trigger persists true join cutovers, including unobserved rejoin.
 */
async function notificationMembership(
  db: PoolClient,
  project_id: string,
  account_id: string,
) {
  const result = await db.query(
    `INSERT INTO collaboration_memberships(project_id,account_id,epoch,notification_position)
     VALUES($1,$2,gen_random_uuid(),GREATEST(
       COALESCE((SELECT max(position) FROM collaboration_notification_events WHERE project_id=$1),0),
       COALESCE((SELECT position FROM collaboration_notification_floors WHERE project_id=$1),0)))
     ON CONFLICT(project_id,account_id) DO UPDATE SET epoch=collaboration_memberships.epoch
     RETURNING epoch,notification_position::text`,
    [project_id, account_id],
  );
  return result.rows[0] as { epoch: string; notification_position: string };
}

/** Owner projection callback, under its existing project lock and recipient check.
 * Floors are account-specific metadata, not fields in the shared source catalog.
 */
export async function readCollaborationNotificationAttention(
  db: PoolClient,
  {
    project_id,
    account_id,
    resources,
  }: {
    project_id: string;
    account_id: string;
    resources: readonly CollaborationResource[];
  },
): Promise<{ generation: string; floors: Record<string, number> }> {
  collaborationAccountId(project_id);
  collaborationAccountId(account_id);
  if (
    !Array.isArray(resources) ||
    resources.length > 50 ||
    Buffer.byteLength(JSON.stringify(resources)) > 256 * 1024
  )
    throw Error("collaboration attention page exceeds capacity");
  const floors: Record<string, number> = Object.create(null);
  for (const resource of resources) {
    if (resource.project_id !== project_id)
      throw Error("collaboration attention project mismatch");
    floors[resource.resource_id] = collaborationActivity(resource.activity);
  }
  const membership = await notificationMembership(db, project_id, account_id);
  const threads = resources
    .filter((r) => r.kind === "conversation")
    .map((r) => r.thread_id);
  if (threads.length) {
    const { rows } = await db.query(
      `SELECT event_json->>'thread_id' AS thread_id,min((event_json->>'activity')::bigint) AS activity
       FROM collaboration_notification_events WHERE project_id=$1 AND position>$2::bigint
       AND event_json->>'thread_id'=ANY($3::text[]) GROUP BY event_json->>'thread_id'`,
      [project_id, membership.notification_position, threads],
    );
    const first = new Map(rows.map((r) => [r.thread_id, Number(r.activity)]));
    for (const resource of resources) {
      const activity = first.get(resource.thread_id);
      if (resource.kind === "conversation" && activity != null)
        floors[resource.resource_id] = Math.min(
          resource.activity,
          Math.max(0, activity - 1),
        );
    }
  }
  return { generation: membership.epoch, floors };
}

/** Authorize exactly one durable obligation at the current project owner. This
 * internal lookup is independent of recipient view cursors and access leases.
 * Null is definitive absence/revocation; unavailable authority throws for retry.
 */
export async function readCollaborationNotificationObligation(
  input: CollaborationNotificationObligation,
  authority: { owning_bay_id: string },
): Promise<CollaborationNotificationEntry | null> {
  for (const value of [
    input.project_id,
    input.id,
    input.account_id,
    input.membership_epoch,
  ])
    collaborationAccountId(value);
  return transaction(async (db) => {
    await assertProjectNotRehoming({
      db,
      project_id: input.project_id,
      action: "authorize notification obligation",
    });
    const project = (
      await db.query(
        `SELECT p.users,p.deleted,c.generation FROM projects p
       JOIN collaboration_projects c USING(project_id)
       WHERE p.project_id=$1 AND p.owning_bay_id=$2 FOR SHARE OF p,c`,
        [input.project_id, authority.owning_bay_id],
      )
    ).rows[0];
    if (!project) throw Error("notification project owner unavailable");
    if (project.deleted || !member(project.users?.[input.account_id]?.group))
      return null;
    const pending = (
      await db.query(
        `SELECT e.event_json,e.mention_all_allowed,e.position,m.epoch,m.notification_position
       FROM collaboration_notification_recipients r
       LEFT JOIN collaboration_notification_events e ON e.event_id=r.event_id AND e.project_id=r.project_id
       JOIN collaboration_memberships m ON m.project_id=r.project_id AND m.account_id=r.account_id
       WHERE r.id=$1 AND r.project_id=$2 AND r.account_id=$3 AND r.membership_epoch=$4`,
        [input.id, input.project_id, input.account_id, input.membership_epoch],
      )
    ).rows[0];
    if (pending && !pending.event_json)
      throw Error("pending notification source missing");
    if (
      !pending ||
      pending.epoch !== input.membership_epoch ||
      BigInt(pending.position) <= BigInt(pending.notification_position)
    )
      return null;
    const event = validateCollaborationMessageEvent(pending.event_json);
    // Capture @all policy at admission so role changes cannot rewrite a retained
    // event or change its replay identity. Current membership is still required.
    event.mention_all = pending.mention_all_allowed === true;
    if (event.project_id !== input.project_id)
      throw Error("notification source project mismatch");
    if (!member(project.users?.[event.actor_account_id]?.group)) return null;
    const room = (
      await db.query(
        "SELECT room_id,chat_path FROM collaboration_rooms WHERE project_id=$1",
        [input.project_id],
      )
    ).rows[0];
    if (!room || room.room_id !== event.room_id) return null;
    const resource = (
      await db.query(
        `SELECT metadata,${ownerParticipation("c", "$3")} AS participated
       FROM collaboration_catalog c WHERE project_id=$1 AND entry_key=$2
       AND deleted_at IS NULL AND kind='conversation'`,
        [
          input.project_id,
          entryKey(input.project_id, event.thread_id),
          input.account_id,
        ],
      )
    ).rows[0];
    if (!resource) return null;
    const boundary = await readCollaborationNotificationAttention(db, {
      project_id: input.project_id,
      account_id: input.account_id,
      resources: [resource.metadata],
    });
    const legacy = reconcileCollaborationAttention({
      account_id: input.account_id,
      initial_activity: 0,
      legacy: resource.metadata,
    });
    return {
      event,
      attention: {
        generation: boundary.generation,
        initial_activity: boundary.floors[resource.metadata.resource_id],
        participating: !!resource.participated,
        legacy_following: legacy.following,
        legacy_muted: legacy.muted,
      },
      authority: {
        project_id: event.project_id,
        room_id: event.room_id,
        thread_id: event.thread_id,
        owning_bay_id: authority.owning_bay_id,
        chat_path: room.chat_path,
        access_generation: project.generation,
        actor_role: project.users[event.actor_account_id].group,
        recipient_role: project.users[input.account_id].group,
      },
    };
  });
}

/** Apply after the bounded projection upsert, inside its account-home transaction
 * and access-row lock, before advancing collaboration_access. Each thread's first
 * observation in a recipient membership establishes the owner-provided boundary.
 * `generation` is the recipient epoch, never the project authority generation.
 * Resource activity here is the owner's account-specific floor, not live activity.
 * Replays,
 * ordinary metadata updates and concurrent reads must never advance that boundary.
 */
export async function initializeCollaborationProjectionAttention(
  db: PoolClient,
  {
    account_id,
    project_id,
    generation,
    resources,
  }: {
    account_id: string;
    project_id: string;
    generation: string;
    resources: readonly CollaborationResource[];
  },
): Promise<number> {
  collaborationAccountId(account_id);
  collaborationAccountId(project_id);
  collaborationAccountId(generation);
  if (
    !Array.isArray(resources) ||
    resources.length > 50 ||
    Buffer.byteLength(JSON.stringify(resources)) > 256 * 1024
  )
    throw Error("collaboration attention projection exceeds capacity");
  const keys = new Set<string>();
  const entries = resources.flatMap((resource) => {
    if (resource.project_id !== project_id)
      throw Error("collaboration attention project mismatch");
    if (resource.kind !== "conversation") return [];
    if (
      typeof resource.resource_id !== "string" ||
      !resource.resource_id ||
      resource.resource_id.length > 256
    )
      throw Error("invalid collaboration attention identity");
    const entry_key = entryKey(project_id, resource.resource_id);
    if (keys.has(entry_key))
      throw Error("duplicate collaboration attention identity");
    keys.add(entry_key);
    const legacy = reconcileCollaborationAttention({
      account_id,
      initial_activity: 0,
      legacy: resource as CollaborationResource & LegacyCollaborationAttention,
    });
    return [
      {
        entry_key,
        activity: collaborationActivity(resource.activity),
        following: legacy.following,
        muted: legacy.muted,
      },
    ];
  });
  if (!entries.length) return 0;
  const access = await db.query(
    "SELECT 1 FROM collaboration_access WHERE account_id=$1 AND project_id=$2 FOR UPDATE",
    [account_id, project_id],
  );
  if (!access.rows.length)
    throw Error("notification access projection not ready");
  const result = await db.query(
    `INSERT INTO collaboration_personal AS p
      (account_id,entry_key,project_id,attention_generation,read_through,notify_after,following,muted,legacy_migrated)
     SELECT $1,e.entry_key,$2,$3,e.activity,e.activity,e.following,e.muted,true
     FROM jsonb_to_recordset($4::jsonb) AS e(entry_key text,activity bigint,following boolean,muted boolean)
     ON CONFLICT(account_id,entry_key) DO UPDATE SET
       following=CASE WHEN p.legacy_migrated OR p.following_explicit OR p.following THEN p.following ELSE excluded.following END,
       muted=CASE WHEN p.legacy_migrated OR p.muted_explicit OR p.muted THEN p.muted ELSE excluded.muted END,
       read_through=CASE WHEN p.attention_generation IS DISTINCT FROM excluded.attention_generation
         THEN GREATEST(p.read_through,excluded.read_through) ELSE p.read_through END,
       notify_after=CASE WHEN p.attention_generation IS DISTINCT FROM excluded.attention_generation
         THEN GREATEST(p.notify_after,excluded.notify_after) ELSE p.notify_after END,
       attention_generation=excluded.attention_generation,legacy_migrated=true
     WHERE p.attention_generation IS DISTINCT FROM excluded.attention_generation OR NOT p.legacy_migrated`,
    [account_id, project_id, generation, JSON.stringify(entries)],
  );
  return result.rowCount ?? 0;
}

/** A worker response is valid only while its captured home grant is current.
 * Check the lease using database wall time AFTER obtaining the row lock, so time
 * spent waiting for a writer cannot turn an expired lease into a fresh grant.
 */
async function lockNotificationAccess(
  db: PoolClient,
  account_id: string,
  project_id: string,
  grant_request_id: string | null | undefined,
) {
  const access = (
    await db.query(
      "SELECT generation,granted_generation,grant_request_id FROM collaboration_access WHERE account_id=$1 AND project_id=$2 FOR UPDATE",
      [account_id, project_id],
    )
  ).rows[0];
  if (!access) throw Error("notification access projection not ready");
  if (
    grant_request_id === undefined ||
    access.grant_request_id !== grant_request_id
  )
    throw Error("notification access grant superseded");
  return access;
}

export interface NotificationAuthorizationFence {
  request_id: string;
  generation: string | null;
  granted_generation: string | null;
  expires_at: string;
}

/** One-shot event authorization; do not grant or schedule discovery access. */
export async function prepareCollaborationNotificationAuthorization(
  account_id: string,
  project_id: string,
): Promise<NotificationAuthorizationFence> {
  collaborationAccountId(account_id);
  collaborationAccountId(project_id);
  return withAccountRehomeWriteFence({
    account_id,
    action: "prepare notification authorization",
    fn: async (db) => {
      await db.query(
        `INSERT INTO collaboration_access(account_id,project_id,due_at,lease_due_at)
        VALUES($1,$2,'infinity','infinity') ON CONFLICT DO NOTHING`,
        [account_id, project_id],
      );
      const row = (
        await db.query(
          `UPDATE collaboration_access SET grant_request_id=$3
        WHERE account_id=$1 AND project_id=$2
        RETURNING grant_request_id,generation,granted_generation`,
          [account_id, project_id, randomUUID()],
        )
      ).rows[0];
      const clock = (
        await db.query(
          "SELECT clock_timestamp()+interval '60 seconds' AS expires_at",
        )
      ).rows[0];
      return {
        request_id: row.grant_request_id,
        generation: row.generation,
        granted_generation: row.granted_generation,
        expires_at: clock.expires_at.toISOString(),
      };
    },
  });
}

/** Internal event path: a fresh owner answer plus unchanged home invalidation
 * fence replaces the recurring lease, not the personal state transaction. */
export async function lockEventCollaborationNotificationAttention(input: {
  db: PoolClient;
  delivery: CollaborationNotificationDelivery;
  authorization: NotificationAuthorizationFence;
}) {
  if (!input.delivery.attention)
    throw Error("notification owner attention missing");
  return lockNotificationAttention(input);
}

async function lockNotificationAttention({
  db,
  delivery,
  authorization,
}: {
  db: PoolClient;
  delivery: CollaborationNotificationDelivery;
  authorization: NotificationAuthorizationFence;
}): Promise<{
  access_generation: string;
  state: CollaborationAttentionState;
} | null> {
  const { account_id, event } = delivery;
  const access = await lockNotificationAccess(
    db,
    account_id,
    event.project_id,
    delivery.grant_request_id,
  );
  {
    if (
      delivery.grant_request_id !== authorization.request_id ||
      access.generation !== authorization.generation ||
      access.granted_generation !== authorization.granted_generation
    )
      throw Error("notification authorization superseded");
    const fresh = await db.query(
      "SELECT 1 WHERE clock_timestamp()<$1::timestamptz",
      [authorization.expires_at],
    );
    if (!fresh.rows.length) throw Error("notification authorization expired");
  }
  const visible = (
    await db.query(
      `SELECT 1 FROM account_project_index WHERE account_id=$1 AND project_id=$2
     AND users_summary #>> ARRAY[$1::text,'group'] IN ('owner','collaborator')`,
      [account_id, event.project_id],
    )
  ).rows.length;
  if (!visible) {
    throw Error("notification home membership not ready");
  }
  const key = entryKey(event.project_id, event.thread_id);
  const ownerAttention = validateCollaborationNotificationAttention(
    delivery.attention!,
  );
  await db.query(
    "INSERT INTO collaboration_personal(account_id,entry_key,project_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [account_id, key, event.project_id],
  );
  const personal = (
    await db.query(
      "SELECT * FROM collaboration_personal WHERE account_id=$1 AND entry_key=$2 FOR UPDATE",
      [account_id, key],
    )
  ).rows[0];
  const state = reconcileCollaborationAttention({
    account_id,
    initial_activity: ownerAttention.initial_activity,
    state: {
      following:
        personal.legacy_migrated ||
        personal.following_explicit ||
        personal.following
          ? personal.following
          : undefined,
      muted:
        personal.legacy_migrated || personal.muted_explicit || personal.muted
          ? personal.muted
          : undefined,
      read_through: Math.max(
        Number(personal.read_through),
        personal.attention_generation !== ownerAttention.generation
          ? ownerAttention.initial_activity
          : 0,
      ),
      notify_after: Math.max(
        Number(personal.notify_after),
        personal.attention_generation !== ownerAttention.generation
          ? ownerAttention.initial_activity
          : 0,
      ),
      last_mention: Number(personal.last_mention),
      legacy_migrated: personal.legacy_migrated,
      participating: ownerAttention.participating,
    },
    legacy: {
      notification_followers: ownerAttention.legacy_following
        ? [account_id]
        : [],
      notification_muted: ownerAttention.legacy_muted ? [account_id] : [],
    },
  });
  if (
    event.actor_account_id !== account_id &&
    (event.mention_all || event.mentioned_account_ids.includes(account_id))
  )
    state.last_mention = Math.max(state.last_mention, event.activity);
  await db.query(
    `UPDATE collaboration_personal SET following=$3,muted=$4,legacy_migrated=true,
     notify_after=$5,last_mention=GREATEST(last_mention,$6),
     read_through=GREATEST(read_through,$7),attention_generation=COALESCE($8,attention_generation)
     WHERE account_id=$1 AND entry_key=$2`,
    [
      account_id,
      key,
      state.following,
      state.muted,
      state.notify_after,
      state.last_mention,
      state.read_through,
      ownerAttention.generation,
    ],
  );
  return {
    access_generation: delivery.access_generation,
    state,
  };
}

/** Prune settled events after the replay horizon. Pending expansions and recipient
 * obligations retain their events regardless of age or recipient activity.
 */
export async function pruneCollaborationNotificationEvents(
  bay_id: string,
): Promise<number> {
  return transaction(async (db) => {
    const projects = (
      await db.query(
        `SELECT e.project_id FROM collaboration_notification_events e JOIN projects p USING(project_id)
       WHERE e.created_at < now()-interval '30 days' AND p.owning_bay_id=$1
       GROUP BY e.project_id ORDER BY min(e.created_at),e.project_id LIMIT 10`,
        [bay_id],
      )
    ).rows;
    let removed = 0;
    for (const { project_id } of projects) {
      if (removed >= 200) break;
      try {
        await assertProjectNotRehoming({
          db,
          project_id,
          action: "prune collaboration notifications",
        });
      } catch (err) {
        if (err instanceof ProjectRehomeInProgressError) continue;
        throw err;
      }
      // Same owner lock as append/read; a page cannot observe pruning halfway.
      await db.query(
        "SELECT project_id FROM projects WHERE project_id=$1 FOR UPDATE",
        [project_id],
      );
      const expired = (
        await db.query(
          `SELECT event_id,position::text FROM collaboration_notification_events e
           WHERE project_id=$1 AND created_at<now()-interval '30 days'
           AND position < COALESCE((SELECT min(held.position) FROM collaboration_notification_events held
             WHERE held.project_id=$1 AND (held.fanout_pending OR EXISTS(
               SELECT 1 FROM collaboration_notification_recipients r WHERE r.event_id=held.event_id))),9223372036854775807)
           ORDER BY position LIMIT $2`,
          [project_id, 200 - removed],
        )
      ).rows;
      if (!expired.length) continue;
      await db.query(
        `INSERT INTO collaboration_notification_floors(project_id,position) VALUES($1,$2::bigint)
         ON CONFLICT(project_id) DO UPDATE SET position=GREATEST(collaboration_notification_floors.position,excluded.position)`,
        [project_id, expired[expired.length - 1].position],
      );
      await db.query(
        "DELETE FROM collaboration_notification_events WHERE event_id=ANY($1::uuid[])",
        [expired.map((row) => row.event_id)],
      );
      removed += expired.length;
    }
    return removed;
  });
}
