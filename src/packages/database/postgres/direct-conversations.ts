/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Storage for direct conversations (see @cocalc/util/direct-conversations).
// Owning-bay functions keep the record, messages and an outbox; home-bay
// functions keep each member's index row, blocks and request admissions.
// Callers route to the right bay and check membership; these functions check
// only what their own rows can.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import {
  DIRECT_MESSAGES_PAGE,
  directPreview,
  type DirectPersonalPatch,
  type DirectConversation,
  type DirectMemberState,
  type DirectMessage,
  type ListedDirectConversation,
} from "@cocalc/util/direct-conversations";

const COLUMNS = `conversation_id, member_ids, member_states, created_by,
  created, last_activity, last_sender_id, preview, title, revision,
  messages_version`;

function ms(value: any): number {
  return new Date(value).valueOf();
}

function toConversation(row: any, owner_bay_id: string): DirectConversation {
  return {
    conversation_id: row.conversation_id,
    owner_bay_id,
    member_ids: row.member_ids ?? [],
    member_states: row.member_states ?? {},
    created_by: row.created_by,
    created: ms(row.created),
    last_activity: ms(row.last_activity),
    last_sender_id: row.last_sender_id ?? null,
    preview: row.preview ?? "",
    title: row.title ?? null,
    revision: Number(row.revision ?? 0),
    messages_version: Number(row.messages_version ?? 0),
  };
}

function toMessage(row: any): DirectMessage {
  return {
    message_id: row.message_id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    sent: ms(row.sent),
    body: row.deleted == null ? row.body : "",
    ...(row.deleted == null ? {} : { deleted: true }),
  };
}

const MESSAGE_COLUMNS =
  "message_id, conversation_id, sender_id, sent, body, deleted";

async function inTransaction<T>(f: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await f(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---- owning bay ----

// Queue delivery of this revision to every member, in the change's own
// transaction. A message is kept for the notification until delivered; a later
// change without one doesn't drop it.
async function queueFanout(
  db: PoolClient,
  conversation: DirectConversation,
  message_id: string | null,
  deleted_message_id: string | null = null,
): Promise<void> {
  // Deleted messages accumulate (none is dropped by a later change) until
  // delivered.
  await db.query(
    `INSERT INTO direct_fanout_pending
       (conversation_id, account_id, revision, message_id, deleted_message_ids,
        attempts, next_attempt, last_error)
     SELECT $1, member, $2, $3,
       CASE WHEN $5::uuid IS NULL THEN '{}'::uuid[] ELSE ARRAY[$5::uuid] END,
       0, NOW() + INTERVAL '30 seconds', NULL
     FROM unnest($4::uuid[]) AS member
     ON CONFLICT (conversation_id, account_id) DO UPDATE SET
       revision = GREATEST(direct_fanout_pending.revision, EXCLUDED.revision),
       message_id = COALESCE(EXCLUDED.message_id, direct_fanout_pending.message_id),
       deleted_message_ids = ARRAY(
         SELECT DISTINCT unnest(
           COALESCE(direct_fanout_pending.deleted_message_ids, '{}'::uuid[])
             || EXCLUDED.deleted_message_ids
         )
       ),
       next_attempt = LEAST(direct_fanout_pending.next_attempt, EXCLUDED.next_attempt)`,
    [
      conversation.conversation_id,
      conversation.revision,
      message_id,
      conversation.member_ids,
      deleted_message_id,
    ],
  );
}

// Create a conversation, optionally with its first message. A pair (pair_key
// set) has only one conversation: if it exists, that one is returned with
// created false and nothing changes.
export async function createDirectConversationRecord({
  owner_bay_id,
  created_by,
  member_ids,
  member_states,
  title,
  pair_key,
  body,
  conversation_id = randomUUID(),
}: {
  conversation_id?: string;
  owner_bay_id: string;
  created_by: string;
  member_ids: string[];
  member_states: Record<string, DirectMemberState>;
  title: string | null;
  pair_key: string | null;
  body: string | null;
}): Promise<{
  created: boolean;
  conversation: DirectConversation;
  message: DirectMessage | null;
}> {
  return await inTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO direct_conversations
         (conversation_id, member_ids, member_states, created_by, created,
          last_activity, last_sender_id, preview, title, pair_key, revision)
       VALUES ($1, $2::uuid[], $3::jsonb, $4, NOW(), NOW(), NULL, '', $5, $6, 1)
       ON CONFLICT (pair_key) WHERE pair_key IS NOT NULL DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        conversation_id,
        member_ids,
        JSON.stringify(member_states),
        created_by,
        title,
        pair_key,
      ],
    );
    if (rows[0] == null) {
      const { rows: existing } = await db.query(
        `SELECT ${COLUMNS} FROM direct_conversations WHERE pair_key = $1`,
        [pair_key],
      );
      if (existing[0] == null) throw Error("conversation was not created");
      return {
        created: false,
        conversation: toConversation(existing[0], owner_bay_id),
        message: null,
      };
    }
    let conversation = toConversation(rows[0], owner_bay_id);
    let message: DirectMessage | null = null;
    if (body != null) {
      ({ conversation, message } = await insertMessage(db, {
        conversation_id: conversation.conversation_id,
        sender_id: created_by,
        body,
        owner_bay_id,
      }));
    }
    await queueFanout(db, conversation, message?.message_id ?? null);
    return { created: true, conversation, message };
  });
}

export async function getDirectConversationRecord(
  conversation_id: string,
  owner_bay_id: string,
): Promise<DirectConversation | null> {
  const { rows } = await getPool().query(
    `SELECT ${COLUMNS} FROM direct_conversations WHERE conversation_id = $1`,
    [conversation_id],
  );
  return rows[0] == null ? null : toConversation(rows[0], owner_bay_id);
}

export async function getDirectPairRecord(
  pair_key: string,
  owner_bay_id: string,
): Promise<DirectConversation | null> {
  const { rows } = await getPool().query(
    `SELECT ${COLUMNS} FROM direct_conversations WHERE pair_key = $1`,
    [pair_key],
  );
  return rows[0] == null ? null : toConversation(rows[0], owner_bay_id);
}

// The latest message sets the sender and preview: an older transaction that
// commits last doesn't pair the latest time with its own message.
async function insertMessage(
  db: PoolClient,
  {
    conversation_id,
    sender_id,
    body,
    owner_bay_id,
  }: {
    conversation_id: string;
    sender_id: string;
    body: string;
    owner_bay_id: string;
  },
): Promise<{ message: DirectMessage; conversation: DirectConversation }> {
  const { rows: messages } = await db.query(
    `INSERT INTO direct_messages (message_id, conversation_id, sender_id, sent, body)
     VALUES ($1, $2, $3, clock_timestamp(), $4)
     RETURNING ${MESSAGE_COLUMNS}`,
    [randomUUID(), conversation_id, sender_id, body],
  );
  const message = toMessage(messages[0]);
  // Compare with the stored time, not a JavaScript Date: that has only
  // milliseconds, so a first message sent in the same millisecond as the
  // conversation was created looked older and never set the preview.
  const { rows } = await db.query(
    `WITH m AS (SELECT sent FROM direct_messages WHERE message_id = $2)
     UPDATE direct_conversations SET
       last_sender_id = CASE WHEN m.sent >= last_activity
         THEN $3::uuid ELSE last_sender_id END,
       preview = CASE WHEN m.sent >= last_activity
         THEN $4 ELSE preview END,
       last_activity = GREATEST(last_activity, m.sent),
       revision = revision + 1,
       messages_version = COALESCE(messages_version, 0) + 1
     FROM m
     WHERE conversation_id = $1
     RETURNING ${COLUMNS}`,
    [conversation_id, message.message_id, sender_id, directPreview(body)],
  );
  if (rows[0] == null) throw Error("conversation not found");
  return { message, conversation: toConversation(rows[0], owner_bay_id) };
}

export async function addDirectMessage(opts: {
  conversation_id: string;
  sender_id: string;
  body: string;
  owner_bay_id: string;
}): Promise<{ message: DirectMessage; conversation: DirectConversation }> {
  return await inTransaction(async (db) => {
    const result = await insertMessage(db, opts);
    await queueFanout(db, result.conversation, result.message.message_id);
    return result;
  });
}

export const DIRECT_NOT_ACCEPTED =
  "your message request hasn't been accepted yet";

// Send as one transaction holding the conversation's row lock, so concurrent
// sends see each other: the sender's standing, replying-accepts, and the
// consent rule are decided on the locked row.
//
// Consent rule: while anyone else in it hasn't accepted (a request still
// pending, or declined or blocked, which look the same to everyone else), a
// conversation holds only its first message: the request. Replying to a
// request accepts it.
export async function sendDirectMessage({
  conversation_id,
  sender_id,
  body,
  owner_bay_id,
}: {
  conversation_id: string;
  sender_id: string;
  body: string;
  owner_bay_id: string;
}): Promise<{ message: DirectMessage; conversation: DirectConversation }> {
  return await inTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT ${COLUMNS} FROM direct_conversations
       WHERE conversation_id = $1 FOR UPDATE`,
      [conversation_id],
    );
    if (rows[0] == null) throw Error("conversation not found");
    let conversation = toConversation(rows[0], owner_bay_id);
    if (!conversation.member_ids.includes(sender_id)) {
      throw Error("conversation not found");
    }
    const state = conversation.member_states[sender_id] ?? "active";
    if (state === "declined" || state === "blocked") {
      throw Error("conversation not found");
    }
    if (state === "requested") {
      const { rows: accepted } = await db.query(
        `UPDATE direct_conversations
         SET member_states = jsonb_set(member_states, ARRAY[$2::text], '"active"'::jsonb),
             revision = revision + 1
         WHERE conversation_id = $1
         RETURNING ${COLUMNS}`,
        [conversation_id, sender_id],
      );
      conversation = toConversation(accepted[0], owner_bay_id);
    }
    const waiting = conversation.member_ids.some(
      (id) =>
        id !== sender_id &&
        (conversation.member_states[id] ?? "active") !== "active",
    );
    if (waiting) {
      const { rows: counted } = await db.query(
        "SELECT count(*)::int AS n FROM direct_messages WHERE conversation_id = $1",
        [conversation_id],
      );
      if ((counted[0]?.n ?? 0) > 0) throw Error(DIRECT_NOT_ACCEPTED);
    }
    const result = await insertMessage(db, {
      conversation_id,
      sender_id,
      body,
      owner_bay_id,
    });
    await queueFanout(db, result.conversation, result.message.message_id);
    return result;
  });
}

export async function getDirectMessage(
  message_id: string,
): Promise<DirectMessage | null> {
  const { rows } = await getPool().query(
    `SELECT ${MESSAGE_COLUMNS}
     FROM direct_messages WHERE message_id = $1`,
    [message_id],
  );
  return rows[0] == null ? null : toMessage(rows[0]);
}

// Newest first, before an optional time; the caller reverses for display.
export async function listDirectMessages({
  conversation_id,
  before,
  limit = DIRECT_MESSAGES_PAGE,
}: {
  conversation_id: string;
  before?: number | null;
  limit?: number;
}): Promise<DirectMessage[]> {
  const { rows } = await getPool().query(
    `SELECT ${MESSAGE_COLUMNS}
     FROM direct_messages
     WHERE conversation_id = $1 AND ($2::timestamp IS NULL OR sent < $2)
     ORDER BY sent DESC
     LIMIT $3`,
    [
      conversation_id,
      before == null ? null : new Date(before),
      Math.max(1, Math.min(limit, DIRECT_MESSAGES_PAGE)),
    ],
  );
  return rows.map(toMessage);
}

export async function setDirectMemberState({
  conversation_id,
  account_id,
  state,
  owner_bay_id,
}: {
  conversation_id: string;
  account_id: string;
  state: DirectMemberState;
  owner_bay_id: string;
}): Promise<DirectConversation | null> {
  return await inTransaction(async (db) => {
    const { rows } = await db.query(
      `UPDATE direct_conversations
       SET member_states = jsonb_set(member_states, ARRAY[$2::text], to_jsonb($3::text)),
           revision = revision + 1
       WHERE conversation_id = $1 AND $2::uuid = ANY(member_ids)
       RETURNING ${COLUMNS}`,
      [conversation_id, account_id, state],
    );
    if (rows[0] == null) return null;
    const conversation = toConversation(rows[0], owner_bay_id);
    await queueFanout(db, conversation, null);
    return conversation;
  });
}

export interface DirectFanoutRow {
  conversation_id: string;
  account_id: string;
  revision: number;
  message_id: string | null;
  deleted_message_ids?: string[];
}

export async function pendingDirectFanouts({
  conversation_id,
  due,
  limit = 100,
}: {
  conversation_id?: string;
  due?: boolean;
  limit?: number;
}): Promise<DirectFanoutRow[]> {
  const { rows } = await getPool().query(
    `SELECT conversation_id, account_id, revision, message_id,
       COALESCE(deleted_message_ids, '{}'::uuid[]) AS deleted_message_ids
     FROM direct_fanout_pending
     WHERE ($1::uuid IS NULL OR conversation_id = $1)
       AND (NOT $2::boolean OR next_attempt <= NOW())
     ORDER BY next_attempt LIMIT $3`,
    [conversation_id ?? null, !!due, limit],
  );
  return rows.map((row) => ({ ...row, revision: Number(row.revision) }));
}

// Delivered: clear unless a newer change queued meanwhile, including a
// message deleted since this row was read (its redaction is still owed).
export async function clearDirectFanout(row: DirectFanoutRow): Promise<void> {
  await getPool().query(
    `DELETE FROM direct_fanout_pending
     WHERE conversation_id = $1 AND account_id = $2
       AND revision <= $3
       AND message_id IS NOT DISTINCT FROM $4
       AND COALESCE(deleted_message_ids, '{}'::uuid[]) <@ $5::uuid[]`,
    [
      row.conversation_id,
      row.account_id,
      row.revision,
      row.message_id,
      row.deleted_message_ids ?? [],
    ],
  );
}

// Not delivered: try again later, backing off to at most an hour; never
// given up, so a home bay that comes back still gets it.
export async function recordDirectFanoutFailure({
  conversation_id,
  account_id,
  error,
}: {
  conversation_id: string;
  account_id: string;
  error: string;
}): Promise<void> {
  await getPool().query(
    `UPDATE direct_fanout_pending SET
       attempts = attempts + 1,
       next_attempt = NOW() + LEAST(
         INTERVAL '1 hour',
         INTERVAL '30 seconds' * power(2, LEAST(attempts, 10))
       ),
       last_error = $3
     WHERE conversation_id = $1 AND account_id = $2`,
    [conversation_id, account_id, error.slice(0, 1000)],
  );
}

// ---- member's home bay ----

const INDEX_COLUMNS = `conversation_id, owner_bay_id, member_ids, member_states,
  created_by, created, last_activity, last_sender_id, preview, title,
  revision, messages_version, last_read, muted, pinned, archived_through,
  notified_message_id, request_notified`;

export interface DirectIndexRow extends ListedDirectConversation {
  notified_message_id: string | null;
  request_notified: boolean;
}

function toListed(row: any, account_id: string): DirectIndexRow {
  const conversation = toConversation(row, row.owner_bay_id);
  return {
    ...conversation,
    state: conversation.member_states[account_id] ?? "active",
    last_read: row.last_read == null ? null : ms(row.last_read),
    muted: !!row.muted,
    pinned: !!row.pinned,
    archived_through:
      row.archived_through == null ? null : ms(row.archived_through),
    notified_message_id: row.notified_message_id ?? null,
    request_notified: !!row.request_notified,
  };
}

// Record a revision of a conversation for one member, keeping their read
// marker, mute and notification bookkeeping. Revisions older than (or equal
// to) the stored one change nothing. Returns the row as it is now.
export async function upsertDirectIndex({
  account_id,
  conversation,
}: {
  account_id: string;
  conversation: DirectConversation;
}): Promise<DirectIndexRow> {
  const { rows } = await getPool().query(
    `INSERT INTO account_direct_conversations
       (account_id, conversation_id, owner_bay_id, member_ids, member_states,
        created_by, created, last_activity, last_sender_id, preview, title,
        revision, messages_version, last_read, muted, notified_message_id,
        request_notified, updated)
     VALUES ($1, $2, $3, $4::uuid[], $5::jsonb, $6, $7, $8, $9, $10, $11, $12,
             $13, NULL, FALSE, NULL, FALSE, NOW())
     ON CONFLICT (account_id, conversation_id) DO UPDATE SET
       owner_bay_id = EXCLUDED.owner_bay_id,
       member_ids = EXCLUDED.member_ids,
       member_states = EXCLUDED.member_states,
       title = EXCLUDED.title,
       last_activity = EXCLUDED.last_activity,
       last_sender_id = EXCLUDED.last_sender_id,
       preview = EXCLUDED.preview,
       revision = EXCLUDED.revision,
       messages_version = EXCLUDED.messages_version,
       updated = NOW()
     WHERE COALESCE(account_direct_conversations.revision, 0) < EXCLUDED.revision`,
    [
      account_id,
      conversation.conversation_id,
      conversation.owner_bay_id,
      conversation.member_ids,
      JSON.stringify(conversation.member_states),
      conversation.created_by,
      new Date(conversation.created),
      new Date(conversation.last_activity),
      conversation.last_sender_id,
      conversation.preview,
      conversation.title,
      conversation.revision,
      conversation.messages_version ?? 0,
    ],
  );
  void rows;
  const current = await getDirectIndexRow(
    account_id,
    conversation.conversation_id,
  );
  if (current == null) throw Error("conversation was not recorded");
  return current;
}

export async function getDirectIndexRow(
  account_id: string,
  conversation_id: string,
): Promise<DirectIndexRow | null> {
  const { rows } = await getPool().query(
    `SELECT ${INDEX_COLUMNS} FROM account_direct_conversations
     WHERE account_id = $1 AND conversation_id = $2`,
    [account_id, conversation_id],
  );
  return rows[0] == null ? null : toListed(rows[0], account_id);
}

// The member was notified (only after the notification was created).
export async function recordDirectNotified({
  account_id,
  conversation_id,
  message_id,
  request,
}: {
  account_id: string;
  conversation_id: string;
  message_id: string;
  request: boolean;
}): Promise<void> {
  await getPool().query(
    `UPDATE account_direct_conversations SET
       notified_message_id = $3,
       request_notified = request_notified OR $4
     WHERE account_id = $1 AND conversation_id = $2`,
    [account_id, conversation_id, message_id, request],
  );
}

export async function listDirectIndex(
  account_id: string,
  limit = 500,
): Promise<DirectIndexRow[]> {
  const { rows } = await getPool().query(
    `SELECT ${INDEX_COLUMNS} FROM account_direct_conversations
     WHERE account_id = $1
     ORDER BY last_activity DESC LIMIT $2`,
    [account_id, limit],
  );
  return rows
    .map((row) => toListed(row, account_id))
    .filter((c) => c.state !== "declined" && c.state !== "blocked");
}

export async function getDirectIndex(
  account_id: string,
  conversation_id: string,
): Promise<ListedDirectConversation | null> {
  return await getDirectIndexRow(account_id, conversation_id);
}

export async function markDirectRead({
  account_id,
  conversation_id,
  read_through,
}: {
  account_id: string;
  conversation_id: string;
  read_through: number;
}): Promise<void> {
  await getPool().query(
    `UPDATE account_direct_conversations
     SET last_read = GREATEST(COALESCE(last_read, 'epoch'::timestamp), LEAST($3::timestamp, last_activity)),
         updated = NOW()
     WHERE account_id = $1 AND conversation_id = $2`,
    [account_id, conversation_id, new Date(read_through)],
  );
}

// A member's own settings (mute, pin, archive), on their home bay. Only the
// given fields change. Archiving can't reach into the future.
export async function setDirectPersonal({
  account_id,
  conversation_id,
  patch,
}: {
  account_id: string;
  conversation_id: string;
  patch: DirectPersonalPatch;
}): Promise<void> {
  const archive = patch.archived_through;
  await getPool().query(
    `UPDATE account_direct_conversations SET
       muted = COALESCE($3, muted),
       pinned = COALESCE($4, pinned),
       archived_through = CASE
         WHEN NOT $5::boolean THEN archived_through
         -- LEAST ignores NULL, so null (show everything) is handled first.
         WHEN $6::timestamp IS NULL THEN NULL
         ELSE LEAST($6::timestamp, NOW()) END,
       updated = NOW()
     WHERE account_id = $1 AND conversation_id = $2`,
    [
      account_id,
      conversation_id,
      patch.muted ?? null,
      patch.pinned ?? null,
      archive !== undefined,
      archive == null ? null : new Date(archive),
    ],
  );
}

// The sender deletes their own message for everyone: its text is cleared and
// a placeholder stays. If it was the latest, the preview shows the latest
// message that remains.
export async function deleteDirectMessage({
  conversation_id,
  message_id,
  sender_id,
  owner_bay_id,
}: {
  conversation_id: string;
  message_id: string;
  sender_id: string;
  owner_bay_id: string;
}): Promise<DirectConversation> {
  return await inTransaction(async (db) => {
    const { rows: locked } = await db.query(
      `SELECT ${COLUMNS} FROM direct_conversations
       WHERE conversation_id = $1 FOR UPDATE`,
      [conversation_id],
    );
    if (locked[0] == null) throw Error("conversation not found");
    const { rows: deleted } = await db.query(
      `UPDATE direct_messages SET body = '', deleted = NOW()
       WHERE message_id = $1 AND conversation_id = $2 AND sender_id = $3
         AND deleted IS NULL
       RETURNING message_id`,
      [message_id, conversation_id, sender_id],
    );
    if (deleted[0] == null) throw Error("message not found");
    const { rows: latest } = await db.query(
      `SELECT sender_id, body FROM direct_messages
       WHERE conversation_id = $1 AND deleted IS NULL
       ORDER BY sent DESC LIMIT 1`,
      [conversation_id],
    );
    const { rows } = await db.query(
      `UPDATE direct_conversations SET
         preview = $2,
         last_sender_id = $3,
         revision = revision + 1,
         messages_version = COALESCE(messages_version, 0) + 1
       WHERE conversation_id = $1
       RETURNING ${COLUMNS}`,
      [
        conversation_id,
        latest[0] == null ? "" : directPreview(latest[0].body),
        latest[0]?.sender_id ?? null,
      ],
    );
    const conversation = toConversation(rows[0], owner_bay_id);
    await queueFanout(db, conversation, null, message_id);
    return conversation;
  });
}

export async function blockDirectSender(
  account_id: string,
  blocked_account_id: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO account_direct_blocks (account_id, blocked_account_id, created)
     VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
    [account_id, blocked_account_id],
  );
}

export async function unblockDirectSender(
  account_id: string,
  blocked_account_id: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM account_direct_blocks
     WHERE account_id = $1 AND blocked_account_id = $2`,
    [account_id, blocked_account_id],
  );
}

export async function isDirectBlocked(
  account_id: string,
  sender_id: string,
): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM account_direct_blocks
     WHERE account_id = $1 AND blocked_account_id = $2`,
    [account_id, sender_id],
  );
  return rows.length > 0;
}

// Whether two accounts share, or shared, a project: the collaborator index
// (which this bay keeps for its own accounts), a project this bay owns, or
// another bay's project in the account's project index. A local copy of another bay's project never
// counts: it may be stale.
export async function areCollaborators(
  account_id: string,
  other_id: string,
  bay_id: string,
): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM account_collaborator_index
     WHERE account_id = $1 AND collaborator_account_id = $2
     UNION ALL
     SELECT 1 FROM projects
     WHERE deleted IS NOT TRUE
       AND COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $3::text) = $3::text
       AND users -> $1::text ->> 'group' IN ('owner', 'collaborator')
       AND users -> $2::text ->> 'group' IN ('owner', 'collaborator')
     UNION ALL
     -- Another bay's project, from the account's project index, which the
     -- owning bay keeps current (the collaborator index may not have it yet).
     SELECT 1 FROM account_project_index i
     WHERE i.account_id = $1::uuid
       AND i.users_summary -> $1::text ->> 'group' IN ('owner', 'collaborator')
       AND i.users_summary -> $2::text ->> 'group' IN ('owner', 'collaborator')
       AND NOT EXISTS (
         SELECT 1 FROM projects lp
         WHERE lp.project_id = i.project_id
           AND COALESCE(NULLIF(BTRIM(lp.owning_bay_id), ''), $3::text) = $3::text
       )
     LIMIT 1`,
    [account_id, other_id, bay_id],
  );
  return rows.length > 0;
}

// Charge a conversation with requests against its starter's daily quota, on
// the starter's home bay, before it is created (under the account's lock, so
// concurrent starts can't all pass). Later answers don't refund it; only
// releaseDirectRequest does, when the conversation wasn't created after all.
export async function admitDirectRequest({
  account_id,
  conversation_id,
  recipients,
  requests_per_day,
  recipients_per_day,
}: {
  account_id: string;
  conversation_id: string;
  recipients: number;
  // The account's limits (its membership tier, or the defaults).
  requests_per_day: number;
  recipients_per_day: number;
}): Promise<void> {
  await inTransaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('direct-request-admission'), hashtext($1::text))",
      [account_id],
    );
    const { rows } = await db.query(
      `SELECT count(*)::int AS n, COALESCE(sum(recipients), 0)::int AS people
       FROM direct_request_admissions
       WHERE account_id = $1 AND created > NOW() - INTERVAL '1 day'`,
      [account_id],
    );
    const n = rows[0]?.n ?? 0;
    const people = rows[0]?.people ?? 0;
    if (n + 1 > requests_per_day || people + recipients > recipients_per_day) {
      throw Error(
        `you have reached your daily limit on message requests (${requests_per_day} requests to at most ${recipients_per_day} people); try again later or upgrade your membership`,
      );
    }
    await db.query(
      `INSERT INTO direct_request_admissions
         (conversation_id, account_id, recipients, created)
       VALUES ($1, $2, $3, NOW())`,
      [conversation_id, account_id, recipients],
    );
  });
}

export async function releaseDirectRequest(
  conversation_id: string,
): Promise<void> {
  await getPool().query(
    "DELETE FROM direct_request_admissions WHERE conversation_id = $1",
    [conversation_id],
  );
}

export const DELETED_MESSAGE_TEXT = "Message deleted";

// Replace a deleted message's text wherever a notice summary carries it.
function redactBodyText(value: any): any {
  if (Array.isArray(value)) return value.map(redactBodyText);
  if (value == null || typeof value !== "object") return value;
  const result: Record<string, any> = {};
  for (const [key, inner] of Object.entries(value)) {
    result[key] =
      key === "body_text" && typeof inner === "string"
        ? DELETED_MESSAGE_TEXT
        : redactBodyText(inner);
  }
  return result;
}

// On a recipient's home bay, after its sender deleted a message: the notice
// about it (identified by its dedupe key) no longer carries its text, in the
// notification itself, its outbox (so a later projection or rebuild can't
// bring it back), the recipient's notification list, and any email not yet
// sent, which is cancelled. Email already sent can't be recalled. Returns the
// notification list ids that changed, to publish.
export async function redactDirectMessageNotice({
  account_id,
  message_id,
}: {
  account_id: string;
  message_id: string;
}): Promise<string[]> {
  const dedupe_key = `direct-message:${message_id}:${account_id}`;
  return await inTransaction(async (db) => {
    const { rows: targets } = await db.query(
      `SELECT event_id, notification_id FROM notification_targets
       WHERE target_account_id = $1 AND dedupe_key = $2`,
      [account_id, dedupe_key],
    );
    if (targets.length === 0) return [];
    const event_ids = targets.map((t) => t.event_id);
    const notification_ids = targets.map((t) => t.notification_id);
    const rewrite = async (
      table: string,
      column: string,
      where: string,
      params: any[],
      key: string,
    ) => {
      const { rows } = await db.query(
        `SELECT ${key} AS key, ${column} AS value FROM ${table} WHERE ${where}`,
        params,
      );
      for (const row of rows) {
        await db.query(
          `UPDATE ${table} SET ${column} = $2::jsonb WHERE ${key} = $1`,
          [row.key, JSON.stringify(redactBodyText(row.value))],
        );
      }
    };
    await rewrite(
      "notification_events",
      "payload_json",
      "event_id = ANY($1::uuid[])",
      [event_ids],
      "event_id",
    );
    await rewrite(
      "notification_target_outbox",
      "payload_json",
      "notification_id = ANY($1::uuid[]) AND target_account_id = $2",
      [notification_ids, account_id],
      "outbox_id",
    );
    // Email: not sent yet is cancelled; every copy loses the text.
    const { rows: emails } = await db.query(
      `UPDATE notification_email_outbox
         SET status = CASE WHEN status = 'queued'
               THEN 'skipped_preference' ELSE status END,
             last_error = CASE WHEN status = 'queued'
               THEN 'the message was deleted by its sender' ELSE last_error END,
             updated_at = NOW()
       WHERE notification_id = ANY($1::uuid[]) AND target_account_id = $2
       RETURNING email_id, summary_json`,
      [notification_ids, account_id],
    );
    const projected = new Set<string>(notification_ids);
    for (const email of emails) {
      const id = email.summary_json?.projection_notification_id;
      if (typeof id === "string") projected.add(id);
      await db.query(
        `UPDATE notification_email_outbox SET summary_json = $2::jsonb
         WHERE email_id = $1`,
        [email.email_id, JSON.stringify(redactBodyText(email.summary_json))],
      );
    }
    const { rows: listed } = await db.query(
      `SELECT notification_id, summary FROM account_notification_index
       WHERE account_id = $1 AND notification_id = ANY($2::uuid[])`,
      [account_id, [...projected]],
    );
    for (const row of listed) {
      await db.query(
        `UPDATE account_notification_index
           SET summary = $3::jsonb, revision = COALESCE(revision, 0) + 1,
               updated_at = NOW()
         WHERE account_id = $1 AND notification_id = $2`,
        [
          account_id,
          row.notification_id,
          JSON.stringify(redactBodyText(row.summary)),
        ],
      );
    }
    return listed.map((row) => row.notification_id);
  });
}

// A deleted message's tombstone on a member's home bay (idempotent).
export async function recordDirectMessageDeleted({
  account_id,
  message_id,
}: {
  account_id: string;
  message_id: string;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO account_direct_deleted_messages (account_id, message_id, created)
     VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
    [account_id, message_id],
  );
}

export async function isDirectMessageDeleted({
  account_id,
  message_id,
}: {
  account_id: string;
  message_id: string;
}): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM account_direct_deleted_messages
     WHERE account_id = $1 AND message_id = $2`,
    [account_id, message_id],
  );
  return rows.length > 0;
}
