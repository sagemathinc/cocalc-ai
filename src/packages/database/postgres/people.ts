/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// project_conversations lives on the project's owning bay;
// account_people_state lives on the account's home bay.
// Callers are responsible for routing to the right bay.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "./account-rehome-fence";
import { normalizeAgentAppearance } from "@cocalc/util/agent-appearance";
import {
  MAX_CONVERSATION_PARTICIPANTS,
  MAX_CONVERSATIONS_PER_PROJECT,
  MAX_LISTED_PROJECTS,
  type Conversation,
  type PeopleStateKind,
  type PersonalStatePatch,
  type PersonalStateRow,
  type SharedWork,
  type ProjectAgent,
  type AgentCollaboratorAccess,
  MAX_SHARED_WORK_ITEMS,
  assertPeopleStateKind,
  normalizeAlias,
  normalizeConversationPath,
  normalizeConversationTitle,
} from "@cocalc/util/people";

const COLUMNS = `conversation_id, project_id, path, title, created_by, created,
  last_activity, last_sender_id, participant_ids`;

// Same rule as project collaborator access: owner or collaborator of a
// project that is not deleted. Viewers are not conversation participants.
const COLLABORATOR = `EXISTS (
  SELECT 1 FROM projects p
  WHERE p.project_id = c.project_id
    AND p.deleted IS NOT TRUE
    AND p.users -> $ACCOUNT::text ->> 'group' IN ('owner', 'collaborator')
)`;

function collaborator(param: number): string {
  return COLLABORATOR.replace("$ACCOUNT", `$${param}`);
}

function toConversation(row: any): Conversation {
  return {
    conversation_id: row.conversation_id,
    project_id: row.project_id,
    path: row.path,
    title: row.title,
    created_by: row.created_by,
    created: new Date(row.created).valueOf(),
    last_activity: new Date(row.last_activity).valueOf(),
    last_sender_id: row.last_sender_id ?? null,
    participant_ids: row.participant_ids ?? [],
  };
}

async function assertCollaborator(
  account_id: string,
  project_id: string,
): Promise<void> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM projects c WHERE c.project_id = $1 AND ${collaborator(2)}`,
    [project_id, account_id],
  );
  if (rows.length === 0) {
    throw Error("you must be a collaborator on this project");
  }
}

// Idempotent on (project_id, path): adding a file that is already a
// conversation returns the existing record unchanged.
export async function createConversationRecord({
  account_id,
  project_id,
  path,
  title,
}: {
  account_id: string;
  project_id: string;
  path: string;
  title: string;
}): Promise<Conversation> {
  path = normalizeConversationPath(path);
  title = normalizeConversationTitle(title);
  await assertCollaborator(account_id, project_id);
  const { rows: registered } = await getPool().query(
    `SELECT ${COLUMNS} FROM project_conversations
     WHERE project_id = $1 AND path = $2`,
    [project_id, path],
  );
  if (registered[0] != null) return toConversation(registered[0]);
  const { rows: counts } = await getPool().query(
    "SELECT count(*)::int AS n FROM project_conversations WHERE project_id = $1",
    [project_id],
  );
  if ((counts[0]?.n ?? 0) >= MAX_CONVERSATIONS_PER_PROJECT) {
    throw Error("this project has too many conversations");
  }
  const { rows } = await getPool().query(
    `INSERT INTO project_conversations
       (conversation_id, project_id, path, title, created_by, created,
        last_activity, participant_ids)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), ARRAY[]::uuid[])
     ON CONFLICT (project_id, path) DO NOTHING
     RETURNING ${COLUMNS}`,
    [randomUUID(), project_id, path, title, account_id],
  );
  if (rows[0] != null) return toConversation(rows[0]);
  const existing = await getPool().query(
    `SELECT ${COLUMNS} FROM project_conversations
     WHERE project_id = $1 AND path = $2`,
    [project_id, path],
  );
  if (existing.rows[0] == null) throw Error("conversation was not created");
  return toConversation(existing.rows[0]);
}

// Only projects where account_id is currently a collaborator contribute rows,
// so removing someone from a project hides its conversations immediately.
export async function listConversationsForProjects({
  account_id,
  project_ids,
}: {
  account_id: string;
  project_ids: string[];
}): Promise<Conversation[]> {
  if (project_ids.length === 0) return [];
  if (project_ids.length > MAX_LISTED_PROJECTS) {
    throw Error(`at most ${MAX_LISTED_PROJECTS} projects`);
  }
  const { rows } = await getPool().query(
    `SELECT ${COLUMNS} FROM project_conversations c
     WHERE c.project_id = ANY($1::uuid[]) AND ${collaborator(2)}
     ORDER BY c.last_activity DESC
     LIMIT $3`,
    [project_ids, account_id, MAX_CONVERSATIONS_PER_PROJECT * 5],
  );
  return rows.map(toConversation);
}

export async function getConversation({
  account_id,
  project_id,
  conversation_id,
}: {
  account_id: string;
  project_id: string;
  conversation_id: string;
}): Promise<Conversation | null> {
  const { rows } = await getPool().query(
    `SELECT ${COLUMNS} FROM project_conversations c
     WHERE c.project_id = $1 AND c.conversation_id = $2 AND ${collaborator(3)}`,
    [project_id, conversation_id, account_id],
  );
  return rows[0] == null ? null : toConversation(rows[0]);
}

// Called for every human chat message sent through CoCalc. It is a no-op for
// .chat files that are not conversations, so callers need not know.
export async function touchConversation({
  account_id,
  project_id,
  path,
}: {
  account_id: string;
  project_id: string;
  path: string;
}): Promise<Conversation | null> {
  path = normalizeConversationPath(path);
  const { rows } = await getPool().query(
    `UPDATE project_conversations c SET
       last_activity = GREATEST(c.last_activity, NOW()),
       last_sender_id = $3::uuid,
       participant_ids = (
         ARRAY[$3::uuid] || array_remove(c.participant_ids, $3::uuid)
       )[1:$4]
     WHERE c.project_id = $1 AND c.path = $2 AND ${collaborator(3)}
     RETURNING ${COLUMNS}`,
    [project_id, path, account_id, MAX_CONVERSATION_PARTICIPANTS],
  );
  return rows[0] == null ? null : toConversation(rows[0]);
}

// Raise activity to a file modification time seen by an explicit scan (for
// chats edited outside CoCalc's chat UI). Never moves activity backwards or
// into the future, and does not change the last sender.
export async function refreshConversationActivity({
  account_id,
  project_id,
  path,
  activity,
}: {
  account_id: string;
  project_id: string;
  path: string;
  activity: number;
}): Promise<Conversation | null> {
  path = normalizeConversationPath(path);
  if (!Number.isFinite(activity)) throw Error("invalid activity");
  const { rows } = await getPool().query(
    `UPDATE project_conversations c SET
       last_activity = GREATEST(c.last_activity, LEAST($3::timestamp, NOW()))
     WHERE c.project_id = $1 AND c.path = $2 AND ${collaborator(4)}
     RETURNING ${COLUMNS}`,
    [project_id, path, new Date(activity), account_id],
  );
  return rows[0] == null ? null : toConversation(rows[0]);
}

export async function renameConversation({
  account_id,
  project_id,
  conversation_id,
  title,
}: {
  account_id: string;
  project_id: string;
  conversation_id: string;
  title: string;
}): Promise<Conversation> {
  title = normalizeConversationTitle(title);
  const { rows } = await getPool().query(
    `UPDATE project_conversations c SET title = $3
     WHERE c.project_id = $1 AND c.conversation_id = $2 AND ${collaborator(4)}
     RETURNING ${COLUMNS}`,
    [project_id, conversation_id, title, account_id],
  );
  if (rows[0] == null) throw Error("conversation not found");
  return toConversation(rows[0]);
}

// Removes the record only; the .chat file and its messages are untouched.
export async function removeConversation({
  account_id,
  project_id,
  conversation_id,
}: {
  account_id: string;
  project_id: string;
  conversation_id: string;
}): Promise<void> {
  const { rowCount } = await getPool().query(
    `DELETE FROM project_conversations c
     WHERE c.project_id = $1 AND c.conversation_id = $2 AND ${collaborator(3)}`,
    [project_id, conversation_id, account_id],
  );
  if (!rowCount) throw Error("conversation not found");
}

// ---- account home bay: personal state ----

const STATE_COLUMNS = `kind, target_id, project_id, pinned, alias,
  following, muted, last_read, scanned_at`;

function toState(row: any): PersonalStateRow {
  return {
    kind: row.kind,
    target_id: row.target_id,
    project_id: row.project_id ?? null,
    pinned: !!row.pinned,
    alias: row.alias ?? null,
    following: !!row.following,
    muted: !!row.muted,
    last_read: row.last_read == null ? null : row.last_read.valueOf(),
    scanned_at: row.scanned_at == null ? null : row.scanned_at.valueOf(),
  };
}

export async function getPersonalStates({
  account_id,
  kind,
  target_ids,
}: {
  account_id: string;
  kind: PeopleStateKind;
  target_ids: string[];
}): Promise<Map<string, PersonalStateRow>> {
  const states = new Map<string, PersonalStateRow>();
  if (target_ids.length === 0) return states;
  const { rows } = await getPool().query(
    `SELECT ${STATE_COLUMNS} FROM account_people_state
     WHERE account_id = $1 AND kind = $2 AND target_id = ANY($3::uuid[])`,
    [account_id, assertPeopleStateKind(kind), target_ids],
  );
  for (const row of rows) states.set(row.target_id, toState(row));
  return states;
}

export async function listPersonalStates({
  account_id,
  kind,
}: {
  account_id: string;
  kind: PeopleStateKind;
}): Promise<PersonalStateRow[]> {
  const { rows } = await getPool().query(
    `SELECT ${STATE_COLUMNS} FROM account_people_state
     WHERE account_id = $1 AND kind = $2
     ORDER BY updated DESC
     LIMIT 10000`,
    [account_id, assertPeopleStateKind(kind)],
  );
  return rows.map(toState);
}

// Upsert only the fields present in the patch. An empty alias clears it.
export async function setPersonalState({
  account_id,
  kind,
  target_id,
  project_id,
  patch,
  reclaimAliasFrom,
}: {
  account_id: string;
  kind: PeopleStateKind;
  target_id: string;
  project_id?: string | null;
  patch: PersonalStatePatch;
  // Only the server may supply a binding verified unavailable by its project
  // owner. Match it exactly below; never infer absence from this bay's DB.
  reclaimAliasFrom?: { target_id: string; project_id: string };
}): Promise<PersonalStateRow> {
  assertPeopleStateKind(kind);
  const values: Record<string, unknown> = {};
  if (patch.pinned !== undefined) values.pinned = !!patch.pinned;
  if (patch.alias !== undefined) values.alias = normalizeAlias(patch.alias);
  if (patch.following !== undefined) values.following = !!patch.following;
  if (patch.muted !== undefined) values.muted = !!patch.muted;
  if (patch.scanned_at !== undefined) {
    if (patch.scanned_at != null && !Number.isFinite(patch.scanned_at)) {
      throw Error("invalid scanned_at");
    }
    values.scanned_at =
      patch.scanned_at == null ? null : new Date(patch.scanned_at);
  }
  const columns = Object.keys(values);
  const params: unknown[] = [account_id, kind, target_id, project_id ?? null];
  const insertColumns = columns.map((column) => {
    params.push(values[column]);
    return column;
  });
  const placeholders = insertColumns.map((_, n) => `$${n + 5}`);
  const updates = [
    "updated = NOW()",
    "project_id = COALESCE(EXCLUDED.project_id, account_people_state.project_id)",
    ...insertColumns.map((column) => `${column} = EXCLUDED.${column}`),
  ];
  try {
    return await withAccountRehomeWriteFence({
      account_id,
      action: "modify People state",
      fn: async (db) => {
        if (kind === "conversation" && values.alias && reclaimAliasFrom) {
          await db.query(
            `UPDATE account_people_state SET alias = NULL, updated = NOW()
             WHERE account_id = $1 AND kind = 'conversation' AND alias = $2
               AND target_id = $3 AND project_id = $4`,
            [
              account_id,
              values.alias,
              reclaimAliasFrom.target_id,
              reclaimAliasFrom.project_id,
            ],
          );
        }
        const { rows } = await db.query(
          `INSERT INTO account_people_state
         (account_id, kind, target_id, project_id, updated${insertColumns
           .map((column) => `, ${column}`)
           .join("")})
       VALUES ($1, $2, $3, $4, NOW()${placeholders
         .map((placeholder) => `, ${placeholder}`)
         .join("")})
       ON CONFLICT (account_id, kind, target_id)
       DO UPDATE SET ${updates.join(", ")}
       RETURNING ${STATE_COLUMNS}`,
          params,
        );
        return toState(rows[0]);
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      throw Error(`you already use the alias @${values.alias}`);
    }
    throw err;
  }
}

export async function resolveAlias({
  account_id,
  kind,
  alias,
}: {
  account_id: string;
  kind: PeopleStateKind;
  alias: string;
}): Promise<{ target_id: string; project_id: string | null } | null> {
  const normalized = normalizeAlias(alias);
  if (normalized == null) return null;
  const { rows } = await getPool().query(
    `SELECT target_id, project_id FROM account_people_state
     WHERE account_id = $1 AND kind = $2 AND alias = $3`,
    [account_id, assertPeopleStateKind(kind), normalized],
  );
  return rows[0] == null
    ? null
    : { target_id: rows[0].target_id, project_id: rows[0].project_id ?? null };
}

// Monotone: a delayed or stale call can never move the read marker backwards.
export async function markConversationRead({
  account_id,
  project_id,
  conversation_id,
  read_through,
}: {
  account_id: string;
  project_id: string;
  conversation_id: string;
  read_through: number;
}): Promise<void> {
  if (!Number.isFinite(read_through)) throw Error("invalid read_through");
  await withAccountRehomeWriteFence({
    account_id,
    action: "mark conversation read",
    fn: async (db) => {
      await db.query(
        `INSERT INTO account_people_state
       (account_id, kind, target_id, project_id, last_read, updated)
     VALUES ($1, 'conversation', $2, $3, $4, NOW())
     ON CONFLICT (account_id, kind, target_id)
     DO UPDATE SET
       last_read = GREATEST(account_people_state.last_read, EXCLUDED.last_read),
       updated = NOW()`,
        [account_id, conversation_id, project_id, new Date(read_through)],
      );
    },
  });
}

// Latest explicit @mention of this account per (project, path), from the
// account's existing notification projection (home bay). Thread-follow
// notifications are not mentions.
export async function latestMentions({
  account_id,
  project_ids,
}: {
  account_id: string;
  project_ids: string[];
}): Promise<Map<string, number>> {
  const mentions = new Map<string, number>();
  if (project_ids.length === 0) return mentions;
  const { rows } = await getPool().query(
    `SELECT project_id, summary->>'path' AS path, MAX(created_at) AS at
     FROM account_notification_index
     WHERE account_id = $1
       AND kind = 'mention'
       AND project_id = ANY($2::uuid[])
       AND COALESCE(summary->>'notification_reason', 'mention') <> 'thread_follow'
     GROUP BY 1, 2`,
    [account_id, project_ids],
  );
  for (const row of rows) {
    if (!row.path || row.at == null) continue;
    let path: string;
    try {
      path = normalizeConversationPath(row.path);
    } catch {
      continue;
    }
    mentions.set(mentionKey(row.project_id, path), new Date(row.at).valueOf());
  }
  return mentions;
}

export function mentionKey(project_id: string, path: string): string {
  return `${project_id}:${path}`;
}

// A person's registered agents, and the artifacts those agents published, in
// the given projects where both the viewer and the person are currently
// owners or collaborators. Unregistered agent threads are not attributed.
export async function listSharedWork({
  viewer_id,
  person_id,
  project_ids,
}: {
  viewer_id: string;
  person_id: string;
  project_ids: string[];
}): Promise<SharedWork> {
  if (project_ids.length === 0) return { agents: [], artifacts: [] };
  const shared = `
    SELECT p.project_id FROM projects p
    WHERE p.project_id = ANY($1::uuid[])
      AND p.deleted IS NOT TRUE
      AND p.users -> $2::text ->> 'group' IN ('owner', 'collaborator')
      AND p.users -> $3::text ->> 'group' IN ('owner', 'collaborator')`;
  const params = [project_ids, viewer_id, person_id, MAX_SHARED_WORK_ITEMS];
  const agents = await getPool().query(
    `SELECT agent_id, project_id, name, path, thread_id, created_at,
            collaborator_access
     FROM agent_identities
     WHERE project_id IN (${shared})
       AND created_by = $3::uuid AND disabled_at IS NULL
     ORDER BY created_at DESC
     LIMIT $4`,
    params,
  );
  const artifacts = await getPool().query(
    `SELECT c.entry_id, c.project_id, c.metadata, c.created_at,
            a.agent_id, a.name AS agent_name
     FROM artifact_catalog c
     JOIN artifact_catalog_sources s USING (source_id)
     JOIN agent_identities a
       ON a.project_id = c.project_id
      AND a.path = s.chat_path
      AND (a.thread_id = c.thread_id
           OR COALESCE(a.conversation_history, '[]'::jsonb)
              @> jsonb_build_array(jsonb_build_object('thread_id', c.thread_id)))
     WHERE c.project_id IN (${shared})
       AND NOT c.deleted
       AND a.created_by = $3::uuid AND a.disabled_at IS NULL
     ORDER BY c.created_at DESC NULLS LAST
     LIMIT $4`,
    params,
  );
  return {
    agents: agents.rows.map((row) => ({
      agent_id: row.agent_id,
      project_id: row.project_id,
      name: row.name,
      path: row.path,
      thread_id: row.thread_id,
      collaborator_access:
        row.collaborator_access === "view" ? "view" : "message",
      created_at: new Date(row.created_at).valueOf(),
    })),
    artifacts: artifacts.rows.map((row) => ({
      entry_id: row.entry_id,
      project_id: row.project_id,
      title: `${row.metadata?.title ?? ""}` || "Untitled artifact",
      kind: `${row.metadata?.kind ?? ""}`,
      created_at:
        row.created_at == null
          ? Number(row.metadata?.created_at ?? 0)
          : new Date(row.created_at).valueOf(),
      agent_id: row.agent_id,
      agent_name: row.agent_name,
    })),
  };
}

// Registered agents created by other people in the given projects, where the
// viewer is a current owner or collaborator.
export async function listProjectAgents({
  viewer_id,
  project_ids,
}: {
  viewer_id: string;
  project_ids: string[];
}): Promise<ProjectAgent[]> {
  if (project_ids.length === 0) return [];
  const { rows } = await getPool().query(
    `SELECT a.agent_id, a.project_id, a.name, a.path, a.thread_id,
            a.created_by, a.created_at, a.collaborator_access, a.appearance,
            a.runtime
     FROM agent_identities a
     JOIN projects p ON p.project_id = a.project_id
     WHERE a.project_id = ANY($1::uuid[])
       AND p.deleted IS NOT TRUE
       AND p.users -> $2::text ->> 'group' IN ('owner', 'collaborator')
       AND a.created_by <> $2::uuid AND a.disabled_at IS NULL
     ORDER BY a.created_at DESC
     LIMIT $3`,
    [project_ids, viewer_id, MAX_SHARED_WORK_ITEMS],
  );
  return rows.map((row) => ({
    agent_id: row.agent_id,
    project_id: row.project_id,
    name: row.name,
    path: row.path,
    thread_id: row.thread_id,
    created_by: row.created_by,
    collaborator_access:
      row.collaborator_access === "view" ? "view" : "message",
    created_at: new Date(row.created_at).valueOf(),
    appearance: row.appearance ?? null,
    ...(row.runtime ? { runtime: row.runtime } : {}),
  }));
}

// Record the agent thread's theme. Any current collaborator may, since any
// collaborator can change the theme in the .chat file it mirrors.
export async function setAgentAppearance({
  account_id,
  project_id,
  agent_id,
  appearance,
}: {
  account_id: string;
  project_id: string;
  agent_id: string;
  appearance: unknown;
}): Promise<void> {
  const value = normalizeAgentAppearance(appearance);
  const { rowCount } = await getPool().query(
    `UPDATE agent_identities a SET appearance = $4::jsonb
     FROM projects c
     WHERE c.project_id = a.project_id
       AND a.project_id = $1 AND a.agent_id = $2 AND a.disabled_at IS NULL
       AND ${collaborator(3)}`,
    [
      project_id,
      agent_id,
      account_id,
      value == null ? null : JSON.stringify(value),
    ],
  );
  if (!rowCount) throw Error("agent not found");
}

// Read an agent's stated collaborator access; any current collaborator may.
export async function getAgentAccess({
  account_id,
  project_id,
  agent_id,
}: {
  account_id: string;
  project_id: string;
  agent_id: string;
}): Promise<{ access: AgentCollaboratorAccess; is_creator: boolean } | null> {
  const { rows } = await getPool().query(
    `SELECT a.collaborator_access, a.created_by FROM agent_identities a
     JOIN projects c ON c.project_id = a.project_id
     WHERE a.project_id = $1 AND a.agent_id = $2 AND a.disabled_at IS NULL
       AND ${collaborator(3)}`,
    [project_id, agent_id, account_id],
  );
  if (rows[0] == null) return null;
  return {
    access: rows[0].collaborator_access === "view" ? "view" : "message",
    is_creator: rows[0].created_by === account_id,
  };
}

// Only the agent's creator may state the preference.
export async function setAgentAccess({
  account_id,
  project_id,
  agent_id,
  access,
}: {
  account_id: string;
  project_id: string;
  agent_id: string;
  access: AgentCollaboratorAccess;
}): Promise<void> {
  if (access !== "view" && access !== "message") throw Error("invalid access");
  const { rowCount } = await getPool().query(
    `UPDATE agent_identities a SET collaborator_access = $4
     FROM projects c
     WHERE c.project_id = a.project_id
       AND a.project_id = $1 AND a.agent_id = $2 AND a.disabled_at IS NULL
       AND a.created_by = $3::uuid AND ${collaborator(3)}`,
    [project_id, agent_id, account_id, access === "view" ? "view" : null],
  );
  if (!rowCount) throw Error("only the agent's creator can change this");
}
