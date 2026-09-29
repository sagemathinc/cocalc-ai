/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PeopleInviteProjectionEvent } from "@cocalc/conat/inter-bay/people-storage";
import type {
  PeopleAccessInvitation,
  PeopleInvitationHistoryRow,
  PeopleInvitationHistoryQuery,
  PeopleInvitationHistoryPage,
  PeopleInvitationCounts,
} from "@cocalc/util/people-invitation-history";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import {
  ensurePeopleContactInTransaction,
  peopleContactLabel,
} from "./contacts";
import { bumpPeopleRevision, peopleRevision } from "./schema";
import type { PeopleDb } from "./schema";
import {
  withPeopleAccount,
  uuid,
  pageLimit,
  peopleSearch,
  encodePeopleCursor,
  decodePeopleCursor,
} from "./common";

const statuses = [
  "pending",
  "accepted",
  "declined",
  "blocked",
  "expired",
  "canceled",
];
/** Fabric-only input. Explicit allowlist prevents tokens/context/emails from
 * becoming durable projection fields even if a future caller sends extra keys.
 */
export function sanitizeAccessInvitation(
  i: PeopleAccessInvitation,
): PeopleAccessInvitation {
  for (const field of ["invitation_id", "project_id", "sender_account_id"])
    uuid(i[field], field);
  for (const field of ["recipient_account_id", "accepted_account_id"])
    if (i[field] != null) uuid(i[field], field);
  if (
    i.kind !== "access" ||
    !statuses.includes(i.status) ||
    !/^[1-9][0-9]{0,18}$/.test(i.source_version) ||
    !["collaborator", "viewer"].includes(i.role)
  )
    throw Error("invalid access projection");
  const date = (value: string | null) =>
    value == null ? null : new Date(value).toISOString();
  return {
    invitation_id: i.invitation_id,
    kind: "access",
    project_id: i.project_id,
    sender_account_id: i.sender_account_id,
    recipient_account_id: i.recipient_account_id ?? null,
    accepted_account_id: i.accepted_account_id ?? null,
    person_id: null,
    status: i.status,
    role: i.role,
    read_policy: i.read_policy ?? null,
    message: i.message?.slice(0, 4096) ?? null,
    invite_source: i.invite_source,
    scope: i.scope ?? null,
    created_at: date(i.created_at)!,
    updated_at: date(i.updated_at)!,
    expires_at: date(i.expires_at),
    responded_at: date(i.responded_at),
    last_sent_at: date(i.last_sent_at),
    resend_count: i.resend_count ?? 0,
    source_version: i.source_version,
    source_bay_id: i.source_bay_id,
  };
}
export async function applyAccessProjection(opts: PeopleInviteProjectionEvent) {
  const i = sanitizeAccessInvitation(opts.invitation);
  const route = await resolveProjectBay(i.project_id);
  if (
    !route ||
    route.bay_id !== opts.source_bay_id ||
    route.epoch !== opts.source_epoch ||
    i.source_bay_id !== opts.source_bay_id
  )
    throw Error("stale people invitation owner");
  const sender = opts.account_id === i.sender_account_id;
  if (
    !sender &&
    opts.account_id !== i.recipient_account_id &&
    opts.account_id !== i.accepted_account_id &&
    !opts.deleted
  )
    throw Error("invalid invitation projection recipient");
  if (opts.contact_email != null && !sender)
    throw Error("contact email is sender-private");
  return withPeopleAccount(opts.account_id, async (db) => {
    const prior = (
      await db.query(
        "SELECT source_version::text,source_bay_id,invitation->>'kind' AS kind FROM people_invitation_index WHERE account_id=$1 AND invitation_id=$2",
        [opts.account_id, i.invitation_id],
      )
    ).rows[0];
    if (prior?.source_bay_id && prior.source_bay_id !== opts.source_bay_id)
      throw Error("invitation source transfer unsupported");
    if (prior && prior.kind !== "access")
      throw Error("invitation identity kind collision");
    if (prior && BigInt(prior.source_version) >= BigInt(i.source_version))
      return;
    if (sender && !opts.deleted) {
      const recipient =
        opts.contact_email != null
          ? { email: opts.contact_email }
          : i.invite_source === "account" && i.recipient_account_id
            ? { account_id: i.recipient_account_id }
            : undefined;
      if (recipient)
        i.person_id = (
          await ensurePeopleContactInTransaction(db, {
            account_id: opts.account_id,
            recipient,
          })
        ).person_id;
    }
    await db.query(
      `INSERT INTO people_invitation_index(account_id,invitation_id,project_id,source_bay_id,source_version,
      sender_account_id,recipient_account_id,accepted_account_id,person_id,status,expires_at,created_at,deleted,invitation)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
      ON CONFLICT(account_id,invitation_id) DO UPDATE SET source_version=EXCLUDED.source_version,
        recipient_account_id=EXCLUDED.recipient_account_id,accepted_account_id=EXCLUDED.accepted_account_id,
        person_id=COALESCE(EXCLUDED.person_id,people_invitation_index.person_id),status=EXCLUDED.status,
        expires_at=EXCLUDED.expires_at,deleted=EXCLUDED.deleted,invitation=EXCLUDED.invitation`,
      [
        opts.account_id,
        i.invitation_id,
        i.project_id,
        opts.source_bay_id,
        i.source_version,
        i.sender_account_id,
        i.recipient_account_id,
        i.accepted_account_id,
        i.person_id,
        i.status,
        i.expires_at,
        i.created_at,
        opts.deleted,
        JSON.stringify(i),
      ],
    );
    await bumpPeopleRevision(db, opts.account_id);
  });
}
async function expireLocal(db: PeopleDb, account_id: string) {
  const { rows } = await db.query(
    `UPDATE people_invitation_index SET status='expired',
    invitation=jsonb_set(invitation,'{status}','"expired"')
    WHERE account_id=$1 AND NOT deleted AND status='pending' AND expires_at<=now() RETURNING invitation_id`,
    [account_id],
  );
  if (rows.length) await bumpPeopleRevision(db, account_id);
}
async function counts(
  db: PeopleDb,
  account_id: string,
): Promise<PeopleInvitationCounts> {
  const row = (
    await db.query(
      `SELECT
    count(*) FILTER(WHERE sender_account_id=$1)::text AS sent,
    count(*) FILTER(WHERE recipient_account_id=$1 OR accepted_account_id=$1)::text AS received
    FROM people_invitation_index WHERE account_id=$1 AND NOT deleted AND status='pending'`,
      [account_id],
    )
  ).rows[0];
  const n = (
    await db.query(
      `SELECT count(DISTINCT n.notification_id) FILTER(WHERE n.notification_id IS NOT NULL
      AND NOT COALESCE((n.read_state->>'read')::boolean,false)
      AND NOT COALESCE((n.read_state->>'archived')::boolean,false))::text AS unread,
      count(*) FILTER(WHERE n.notification_id IS NULL AND i.invitation->>'notification_id' IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM notification_email_outbox e WHERE e.target_account_id=i.account_id
          AND e.notification_id=(i.invitation->>'notification_id')::uuid AND e.actor_account_id=i.sender_account_id
          AND (e.summary_json->'delivery_policy'->>'creates_in_app')::boolean=false))::text AS missing,
      COALESCE(max(n.updated_at)::text,'') AS updated,
      count(*) FILTER(WHERE (n.read_state->>'read')::boolean)::text AS read,
      count(*) FILTER(WHERE (n.read_state->>'archived')::boolean)::text AS archived
    FROM people_invitation_index i ${notificationJoin}
    WHERE i.account_id=$1 AND NOT i.deleted AND i.invitation->>'kind'='collaboration'
      AND i.recipient_account_id=$1`,
      [account_id],
    )
  ).rows[0];
  return {
    pending: { sent: Number(row.sent), received: Number(row.received) },
    unread: Number(n.missing) ? null : Number(n.unread),
    revision: [
      await peopleRevision(db, account_id),
      n.updated,
      n.read,
      n.archived,
      n.missing,
    ].join(":"),
    coverage: await coverage(db),
  };
}
async function coverage(db: PeopleDb): Promise<"partial" | "complete"> {
  if (isMultiBayCluster()) return "partial";
  const source = (
    await db.query(
      "SELECT to_regclass('public.people_invite_backfill') AS name",
    )
  ).rows[0]?.name;
  if (!source) return "partial";
  const ready = (
    await db.query(`SELECT complete AND
    NOT EXISTS(SELECT 1 FROM people_invite_outbox WHERE delivered_at IS NULL) AND
    NOT EXISTS(SELECT 1 FROM people_collaboration_outbox WHERE delivered_at IS NULL) AS ready
    FROM people_invite_backfill WHERE singleton`)
  ).rows[0]?.ready;
  if (!ready) return "partial";
  if (
    (
      await db.query(
        "SELECT to_regclass('public.people_invitation_operations') AS name",
      )
    ).rows[0]?.name &&
    (
      await db.query(
        "SELECT 1 FROM people_invitation_operations WHERE pending LIMIT 1",
      )
    ).rows.length
  )
    return "partial";
  return "complete";
}
const notificationJoin = `LEFT JOIN account_notification_index n ON n.account_id=i.account_id
  AND i.recipient_account_id=i.account_id AND i.invitation->>'kind'='collaboration'
  AND n.notification_id=NULLIF(i.invitation->>'notification_id','')::uuid`;
export async function getPeopleInvitationCountsLocal({
  account_id,
}: {
  account_id: string;
}) {
  return withPeopleAccount(account_id, async (db) => {
    await expireLocal(db, account_id);
    return counts(db, account_id);
  });
}
export async function listInvitationHistoryLocal(
  opts: PeopleInvitationHistoryQuery,
): Promise<PeopleInvitationHistoryPage> {
  const limit = pageLimit(opts.limit),
    view = opts.view ?? "sent";
  const search = peopleSearch(opts.search);
  if (!["sent", "received", "history"].includes(view))
    throw Error("invalid invitation view");
  if (opts.kind && !["access", "collaboration"].includes(opts.kind))
    throw Error("invalid invitation kind");
  if (
    opts.status &&
    ![...statuses, "active", "withdrawn"].includes(opts.status)
  )
    throw Error("invalid invitation status");
  if (opts.person_id) uuid(opts.person_id, "person_id");
  if (opts.invitation_id) uuid(opts.invitation_id, "invitation_id");
  if (opts.participant_account_id)
    uuid(opts.participant_account_id, "participant_account_id");
  if (
    opts.project_ids &&
    (!Array.isArray(opts.project_ids) || opts.project_ids.length > 25)
  )
    throw Error("too many projects");
  const projects = [...new Set(opts.project_ids ?? [])].sort();
  for (const project of projects) uuid(project, "project_id");
  const binding = JSON.stringify([
    "invitations",
    opts.account_id,
    view,
    opts.invitation_id ?? null,
    opts.person_id ?? null,
    opts.participant_account_id ?? null,
    search,
    projects,
    opts.kind ?? null,
    opts.status ?? null,
  ]);
  const page = await withPeopleAccount(opts.account_id, async (db) => {
    await expireLocal(db, opts.account_id);
    const totals = await counts(db, opts.account_id);
    const cursor = await decodePeopleCursor(
      opts.after,
      binding,
      totals.revision,
    );
    const values: any[] = [opts.account_id];
    const where = ["i.account_id=$1", "NOT i.deleted"];
    if (opts.invitation_id) {
      values.push(opts.invitation_id);
      where.push(`(i.invitation_id=$${values.length}::uuid OR EXISTS (
        SELECT 1 FROM people_invitation_index anchor
        JOIN people_invitation_index g ON g.account_id=anchor.account_id AND NOT g.deleted
          AND g.sender_account_id=anchor.sender_account_id AND g.invitation->>'kind'='collaboration'
          AND (g.invitation_id=anchor.invitation_id OR
            (anchor.invitation->>'notification_id' IS NOT NULL AND
             g.invitation->>'notification_id'=anchor.invitation->>'notification_id'))
        WHERE anchor.account_id=$1 AND anchor.invitation_id=$${values.length}::uuid
          AND NOT anchor.deleted AND anchor.invitation->>'kind'='collaboration'
          AND i.sender_account_id=anchor.sender_account_id
          AND (i.invitation_id=g.invitation_id OR
            g.invitation->'access_invite_ids' ? i.invitation_id::text)
      ))`);
    }
    if (view === "sent") where.push("i.sender_account_id=$1");
    if (view === "received")
      where.push(
        "(i.recipient_account_id=$1 OR i.accepted_account_id=$1)",
        "NOT COALESCE((n.read_state->>'archived')::boolean,false)",
      );
    if (view === "history")
      where.push(
        "(i.status NOT IN ('pending','active') OR COALESCE((n.read_state->>'archived')::boolean,false))",
      );
    if (opts.kind) {
      values.push(opts.kind);
      where.push(`i.invitation->>'kind'=$${values.length}`);
    }
    if (opts.participant_account_id) {
      values.push(opts.participant_account_id);
      where.push(
        `(i.sender_account_id=$${values.length} OR i.recipient_account_id=$${values.length} OR i.accepted_account_id=$${values.length})`,
      );
    }
    if (search) {
      values.push(search);
      where.push(`(strpos(lower(COALESCE(i.invitation->>'message','')),lower($${values.length}))>0 OR
        strpos(lower(COALESCE(i.invitation->'target'->>'label','')),lower($${values.length}))>0)`);
    }
    if (opts.status) {
      values.push(opts.status);
      where.push(`i.status=$${values.length}`);
    }
    if (projects.length) {
      values.push(projects);
      where.push(`i.project_id=ANY($${values.length}::uuid[])`);
    }
    if (opts.person_id) {
      values.push(opts.person_id);
      where.push(`(i.person_id=$${values.length} OR EXISTS(SELECT 1 FROM people_contacts c
        WHERE c.account_id=$1 AND c.person_id=$${values.length} AND c.linked_account_id=i.sender_account_id))`);
    }
    const total = Number(
      (
        await db.query(
          `SELECT count(*)::text AS total FROM people_invitation_index i ${notificationJoin} WHERE ${where.join(" AND ")}`,
          values,
        )
      ).rows[0].total,
    );
    if (cursor) {
      if (cursor.after.length !== 2) throw Error("invalid people cursor");
      values.push(cursor.after[0], cursor.after[1]);
      where.push(
        `(i.created_at,i.invitation_id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
      );
    }
    values.push(limit + 1);
    const rows = (
      await db.query(
        `SELECT i.invitation,n.notification_id AS projected_notification_id,n.read_state,
          c.display_label,c.email_ciphertext,
          COALESCE(NULLIF(BTRIM(s.display_name),''),NULLIF(BTRIM(CONCAT_WS(' ',s.first_name,s.last_name)),'')) AS sender_label,
          COALESCE(NULLIF(BTRIM(r.display_name),''),NULLIF(BTRIM(CONCAT_WS(' ',r.first_name,r.last_name)),'')) AS recipient_public_label
        FROM people_invitation_index i ${notificationJoin}
        LEFT JOIN people_contacts c ON c.account_id=i.account_id AND c.person_id=i.person_id AND i.sender_account_id=i.account_id
        LEFT JOIN accounts s ON s.account_id=i.sender_account_id
        LEFT JOIN accounts r ON r.account_id=i.recipient_account_id
        WHERE ${where.join(" AND ")}
      ORDER BY i.created_at DESC,i.invitation_id DESC LIMIT $${values.length}`,
        values,
      )
    ).rows;
    const items: PeopleInvitationHistoryRow[] = await Promise.all(
      rows.slice(0, limit).map(async (r) => ({
        ...(r.invitation.kind === "collaboration"
          ? {
              ...r.invitation,
              notification_read: r.projected_notification_id
                ? !!r.read_state?.read
                : null,
              notification_archived: r.projected_notification_id
                ? !!r.read_state?.archived
                : null,
              read_at: r.projected_notification_id
                ? (r.read_state?.read_at ?? null)
                : null,
              dismissed_at: r.projected_notification_id
                ? (r.read_state?.archived_at ?? null)
                : null,
            }
          : r.invitation),
        ...(r.invitation.sender_account_id === opts.account_id
          ? {
              recipient_label:
                (await peopleContactLabel(opts.account_id, r)) ??
                r.recipient_public_label ??
                undefined,
            }
          : {}),
        ...(r.sender_label ? { sender_label: r.sender_label } : {}),
      })),
    );
    const last = items[items.length - 1];
    return {
      ...totals,
      items,
      total,
      ...(totals.coverage === "partial"
        ? {
            coverage_message:
              "Invitation backfill or delivery is outstanding, or all-owner coverage has not been verified.",
          }
        : {}),
      ...(rows.length > limit
        ? {
            next: await encodePeopleCursor(
              binding,
              totals.revision,
              [last.created_at, last.invitation_id],
              cursor?.expires,
            ),
          }
        : {}),
    };
  });
  // Resolve channel evidence after releasing the account transaction: recipient
  // reads may target this same home/fence. Never expose recipient engagement.
  const { refreshPeopleHistoryDelivery } = await import("./delivery");
  await refreshPeopleHistoryDelivery(page.items);
  return page;
}
