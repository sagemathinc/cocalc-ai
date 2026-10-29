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
  type DirectConversation,
  type DirectMemberState,
  type DirectMessage,
  type ListedDirectConversation,
} from "@cocalc/util/direct-conversations";

const COLUMNS = `conversation_id, member_ids, member_states, created_by,
  created, last_activity, last_sender_id, preview, title, revision`;

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
  };
}

function toMessage(row: any): DirectMessage {
  return {
    message_id: row.message_id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    sent: ms(row.sent),
    body: row.body,
  };
}

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
): Promise<void> {
  await db.query(
    `INSERT INTO direct_fanout_pending
       (conversation_id, account_id, revision, message_id, attempts,
        next_attempt, last_error)
     SELECT $1, member, $2, $3, 0, NOW() + INTERVAL '30 seconds', NULL
     FROM unnest($4::uuid[]) AS member
     ON CONFLICT (conversation_id, account_id) DO UPDATE SET
       revision = GREATEST(direct_fanout_pending.revision, EXCLUDED.revision),
       message_id = COALESCE(EXCLUDED.message_id, direct_fanout_pending.message_id),
       next_attempt = LEAST(direct_fanout_pending.next_attempt, EXCLUDED.next_attempt)`,
    [
      conversation.conversation_id,
      conversation.revision,
      message_id,
      conversation.member_ids,
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
     RETURNING message_id, conversation_id, sender_id, sent, body`,
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
       revision = revision + 1
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
    `SELECT message_id, conversation_id, sender_id, sent, body
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
    `SELECT message_id, conversation_id, sender_id, sent, body
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
    `SELECT conversation_id, account_id, revision, message_id
     FROM direct_fanout_pending
     WHERE ($1::uuid IS NULL OR conversation_id = $1)
       AND (NOT $2::boolean OR next_attempt <= NOW())
     ORDER BY next_attempt LIMIT $3`,
    [conversation_id ?? null, !!due, limit],
  );
  return rows.map((row) => ({ ...row, revision: Number(row.revision) }));
}

// Delivered: clear unless a newer change queued meanwhile.
export async function clearDirectFanout(row: DirectFanoutRow): Promise<void> {
  await getPool().query(
    `DELETE FROM direct_fanout_pending
     WHERE conversation_id = $1 AND account_id = $2
       AND revision <= $3
       AND message_id IS NOT DISTINCT FROM $4`,
    [row.conversation_id, row.account_id, row.revision, row.message_id],
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
  revision, last_read, muted, notified_message_id, request_notified`;

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
        revision, last_read, muted, notified_message_id, request_notified,
        updated)
     VALUES ($1, $2, $3, $4::uuid[], $5::jsonb, $6, $7, $8, $9, $10, $11, $12,
             NULL, FALSE, NULL, FALSE, NOW())
     ON CONFLICT (account_id, conversation_id) DO UPDATE SET
       owner_bay_id = EXCLUDED.owner_bay_id,
       member_ids = EXCLUDED.member_ids,
       member_states = EXCLUDED.member_states,
       title = EXCLUDED.title,
       last_activity = EXCLUDED.last_activity,
       last_sender_id = EXCLUDED.last_sender_id,
       preview = EXCLUDED.preview,
       revision = EXCLUDED.revision,
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

export async function setDirectMuted({
  account_id,
  conversation_id,
  muted,
}: {
  account_id: string;
  conversation_id: string;
  muted: boolean;
}): Promise<void> {
  await getPool().query(
    `UPDATE account_direct_conversations SET muted = $3, updated = NOW()
     WHERE account_id = $1 AND conversation_id = $2`,
    [account_id, conversation_id, muted],
  );
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
