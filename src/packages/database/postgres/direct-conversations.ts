/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Storage for direct conversations (see @cocalc/util/direct-conversations).
// Owning-bay functions keep the record and messages; home-bay functions keep
// each member's index row and blocks. Callers route to the right bay and
// check membership; these functions check only what their own rows can.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import {
  DIRECT_MESSAGES_PAGE,
  MAX_DIRECT_REQUESTS_PER_DAY,
  directPreview,
  type DirectConversation,
  type DirectMemberState,
  type DirectMessage,
  type ListedDirectConversation,
} from "@cocalc/util/direct-conversations";

const COLUMNS = `conversation_id, member_ids, member_states, created_by,
  created, last_activity, last_sender_id, preview, title`;

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

// ---- owning bay ----

export async function createDirectConversationRecord({
  owner_bay_id,
  created_by,
  member_ids,
  member_states,
  title,
}: {
  owner_bay_id: string;
  created_by: string;
  member_ids: string[];
  member_states: Record<string, DirectMemberState>;
  title: string | null;
}): Promise<DirectConversation> {
  const { rows } = await getPool().query(
    `INSERT INTO direct_conversations
       (conversation_id, member_ids, member_states, created_by, created,
        last_activity, last_sender_id, preview, title)
     VALUES ($1, $2::uuid[], $3::jsonb, $4, NOW(), NOW(), NULL, '', $5)
     RETURNING ${COLUMNS}`,
    [
      randomUUID(),
      member_ids,
      JSON.stringify(member_states),
      created_by,
      title,
    ],
  );
  return toConversation(rows[0], owner_bay_id);
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

// Conversations started today by this account that include a request.
export async function countDirectRequestsToday(
  created_by: string,
): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM direct_conversations
     WHERE created_by = $1 AND created > NOW() - INTERVAL '1 day'
       AND member_states::text LIKE '%"requested"%'`,
    [created_by],
  );
  return rows[0]?.n ?? 0;
}

export async function assertDirectRequestQuota(
  created_by: string,
): Promise<void> {
  if (
    (await countDirectRequestsToday(created_by)) >= MAX_DIRECT_REQUESTS_PER_DAY
  ) {
    throw Error(
      "you have sent the maximum number of message requests for today",
    );
  }
}

export async function addDirectMessage({
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
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: messages } = await client.query(
      `INSERT INTO direct_messages (message_id, conversation_id, sender_id, sent, body)
       VALUES ($1, $2, $3, clock_timestamp(), $4)
       RETURNING message_id, conversation_id, sender_id, sent, body`,
      [randomUUID(), conversation_id, sender_id, body],
    );
    const message = toMessage(messages[0]);
    const { rows } = await client.query(
      `UPDATE direct_conversations SET
         last_activity = GREATEST(last_activity, $2::timestamp),
         last_sender_id = $3, preview = $4
       WHERE conversation_id = $1
       RETURNING ${COLUMNS}`,
      [conversation_id, new Date(message.sent), sender_id, directPreview(body)],
    );
    if (rows[0] == null) throw Error("conversation not found");
    await client.query("COMMIT");
    return { message, conversation: toConversation(rows[0], owner_bay_id) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
  const { rows } = await getPool().query(
    `UPDATE direct_conversations
     SET member_states = jsonb_set(member_states, ARRAY[$2::text], to_jsonb($3::text))
     WHERE conversation_id = $1 AND $2::uuid = ANY(member_ids)
     RETURNING ${COLUMNS}`,
    [conversation_id, account_id, state],
  );
  return rows[0] == null ? null : toConversation(rows[0], owner_bay_id);
}

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
    `INSERT INTO direct_fanout_pending
       (conversation_id, account_id, attempts, next_attempt, last_error)
     VALUES ($1, $2, 1, NOW() + INTERVAL '30 seconds', $3)
     ON CONFLICT (conversation_id, account_id) DO UPDATE SET
       attempts = direct_fanout_pending.attempts + 1,
       next_attempt = NOW() + LEAST(
         INTERVAL '1 hour',
         INTERVAL '30 seconds' * power(2, direct_fanout_pending.attempts)
       ),
       last_error = EXCLUDED.last_error`,
    [conversation_id, account_id, error.slice(0, 1000)],
  );
}

export async function clearDirectFanout(
  conversation_id: string,
  account_id: string,
): Promise<void> {
  await getPool().query(
    "DELETE FROM direct_fanout_pending WHERE conversation_id = $1 AND account_id = $2",
    [conversation_id, account_id],
  );
}

export async function dueDirectFanouts(
  limit = 100,
): Promise<{ conversation_id: string; account_id: string }[]> {
  const { rows } = await getPool().query(
    `SELECT conversation_id, account_id FROM direct_fanout_pending
     WHERE next_attempt <= NOW() AND attempts < 20
     ORDER BY next_attempt LIMIT $1`,
    [limit],
  );
  return rows;
}

// ---- member's home bay ----

const INDEX_COLUMNS = `conversation_id, owner_bay_id, member_ids, member_states,
  created_by, created, last_activity, last_sender_id, preview, title,
  last_read, muted`;

function toListed(row: any, account_id: string): ListedDirectConversation {
  const conversation = toConversation(row, row.owner_bay_id);
  return {
    ...conversation,
    state: conversation.member_states[account_id] ?? "active",
    last_read: row.last_read == null ? null : ms(row.last_read),
    muted: !!row.muted,
  };
}

// Record the latest state of a conversation for one member, keeping their
// read marker and mute. Never moves activity backwards (updates may arrive
// out of order). Returns the previous row, if any.
export async function upsertDirectIndex({
  account_id,
  conversation,
}: {
  account_id: string;
  conversation: DirectConversation;
}): Promise<{
  previous: ListedDirectConversation | null;
  current: ListedDirectConversation;
}> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: before } = await client.query(
      `SELECT ${INDEX_COLUMNS} FROM account_direct_conversations
       WHERE account_id = $1 AND conversation_id = $2 FOR UPDATE`,
      [account_id, conversation.conversation_id],
    );
    const { rows } = await client.query(
      `INSERT INTO account_direct_conversations
         (account_id, conversation_id, owner_bay_id, member_ids, member_states,
          created_by, created, last_activity, last_sender_id, preview, title,
          last_read, muted, updated)
       VALUES ($1, $2, $3, $4::uuid[], $5::jsonb, $6, $7, $8, $9, $10, $11,
               NULL, FALSE, NOW())
       ON CONFLICT (account_id, conversation_id) DO UPDATE SET
         owner_bay_id = EXCLUDED.owner_bay_id,
         member_ids = EXCLUDED.member_ids,
         member_states = EXCLUDED.member_states,
         title = EXCLUDED.title,
         last_activity = GREATEST(account_direct_conversations.last_activity, EXCLUDED.last_activity),
         last_sender_id = CASE
           WHEN EXCLUDED.last_activity >= account_direct_conversations.last_activity
           THEN EXCLUDED.last_sender_id
           ELSE account_direct_conversations.last_sender_id END,
         preview = CASE
           WHEN EXCLUDED.last_activity >= account_direct_conversations.last_activity
           THEN EXCLUDED.preview
           ELSE account_direct_conversations.preview END,
         updated = NOW()
       RETURNING ${INDEX_COLUMNS}`,
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
      ],
    );
    await client.query("COMMIT");
    return {
      previous: before[0] == null ? null : toListed(before[0], account_id),
      current: toListed(rows[0], account_id),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listDirectIndex(
  account_id: string,
  limit = 500,
): Promise<ListedDirectConversation[]> {
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
  const { rows } = await getPool().query(
    `SELECT ${INDEX_COLUMNS} FROM account_direct_conversations
     WHERE account_id = $1 AND conversation_id = $2`,
    [account_id, conversation_id],
  );
  return rows[0] == null ? null : toListed(rows[0], account_id);
}

// An existing conversation between exactly these two people, as listed for
// the first of them.
export async function findDirectPair(
  account_id: string,
  other_id: string,
): Promise<ListedDirectConversation | null> {
  const { rows } = await getPool().query(
    `SELECT ${INDEX_COLUMNS} FROM account_direct_conversations
     WHERE account_id = $1 AND cardinality(member_ids) = 2
       AND $2::uuid = ANY(member_ids) AND title IS NULL
     ORDER BY created LIMIT 1`,
    [account_id, other_id],
  );
  return rows[0] == null ? null : toListed(rows[0], account_id);
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

// Whether two accounts share, or shared, a project, as this bay knows it:
// the collaborator index (which includes other bays' projects) or a project
// stored here.
export async function areCollaborators(
  account_id: string,
  other_id: string,
): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM account_collaborator_index
     WHERE account_id = $1 AND collaborator_account_id = $2
     UNION ALL
     SELECT 1 FROM projects
     WHERE deleted IS NOT TRUE
       AND users -> $1::text ->> 'group' IN ('owner', 'collaborator')
       AND users -> $2::text ->> 'group' IN ('owner', 'collaborator')
     LIMIT 1`,
    [account_id, other_id],
  );
  return rows.length > 0;
}
