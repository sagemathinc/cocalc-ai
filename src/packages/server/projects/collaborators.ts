/*
Add, remove and invite collaborators on projects.
*/

import { db } from "@cocalc/database";
import { listProjectedMyCollaboratorsForAccount } from "@cocalc/database/postgres/account-collaborator-index";
import getPool from "@cocalc/database/pool";
import { callback2 } from "@cocalc/util/async-utils";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import type {
  AddCollaborator,
  MyCollaboratorRow,
  ProjectCollabInviteAction,
  ProjectCollabInviteBlockRow,
  ProjectCollabInviteDirection,
  ProjectCollabInviteRow,
  ProjectCollabInviteStatus,
  ProjectCollaboratorRow,
} from "@cocalc/conat/hub/api/projects";
import { add_collaborators_to_projects } from "./collab";
import {
  days_ago,
  is_array,
  is_valid_email_address,
  is_valid_uuid_string,
  lower_email_address,
  uuid,
} from "@cocalc/util/misc";
import getLogger from "@cocalc/backend/logger";
import { send_invite_email } from "@cocalc/server/hub/email";
import getEmailAddress from "@cocalc/server/accounts/get-email-address";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { is_paying_customer } from "@cocalc/database/postgres/account/queries";
import { project_has_network_access } from "@cocalc/database/postgres/project/queries";
import { RESEND_INVITE_INTERVAL_DAYS } from "@cocalc/util/consts/invites";
import { syncProjectUsersOnHost } from "@cocalc/server/project-host/control";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";

const logger = getLogger("project:collaborators");
const COLLAB_GROUPS = ["owner", "collaborator"] as const;
const COLLAB_GROUP_SET = new Set<string>(COLLAB_GROUPS);
const COLLAB_INVITE_EXPIRES_DAYS = 30;
const COLLAB_INVITE_EXPIRES_INTERVAL = `${COLLAB_INVITE_EXPIRES_DAYS} days`;
const EMAIL_ONLY_INVITE_TTL_DAYS = 14;
const EMAIL_ONLY_INVITE_TTL_SECONDS = EMAIL_ONLY_INVITE_TTL_DAYS * 24 * 60 * 60;
const EMAIL_ONLY_INVITE_PREFIX = "email-action:";
const INVITE_STATUS_SET = new Set<string>([
  "pending",
  "accepted",
  "declined",
  "blocked",
  "expired",
  "canceled",
]);

type CollaboratorReadMode = "off" | "prefer" | "only";

function getCollaboratorReadMode(): CollaboratorReadMode {
  const value =
    `${process.env.COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS ?? ""}`
      .trim()
      .toLowerCase();
  if (
    value === "1" ||
    value === "true" ||
    value === "on" ||
    value === "prefer"
  ) {
    return "prefer";
  }
  if (value === "only" || value === "strict" || value === "required") {
    return "only";
  }
  return "off";
}

function normalizeInviteDirection(
  value?: ProjectCollabInviteDirection,
): ProjectCollabInviteDirection {
  const direction = `${value ?? "all"}`.trim().toLowerCase();
  if (
    direction === "inbound" ||
    direction === "outbound" ||
    direction === "all"
  ) {
    return direction;
  }
  throw new Error(
    `invalid direction '${value}' (expected inbound, outbound, or all)`,
  );
}

function normalizeInviteStatus(
  value?: ProjectCollabInviteStatus,
): ProjectCollabInviteStatus | undefined {
  if (value == null) return undefined;
  const status = `${value}`.trim().toLowerCase();
  if (INVITE_STATUS_SET.has(status)) {
    return status as ProjectCollabInviteStatus;
  }
  throw new Error(
    `invalid status '${value}' (expected pending, accepted, declined, blocked, expired, or canceled)`,
  );
}

function normalizeInviteAction(
  value: ProjectCollabInviteAction,
): ProjectCollabInviteAction {
  const action = `${value}`.trim().toLowerCase();
  if (
    action === "accept" ||
    action === "decline" ||
    action === "block" ||
    action === "revoke"
  ) {
    return action;
  }
  throw new Error(
    `invalid action '${value}' (expected accept, decline, block, or revoke)`,
  );
}

function ensureUuid(value: string, label: string): void {
  if (!is_valid_uuid_string(value)) {
    throw new Error(`${label} must be a valid uuid`);
  }
}

function isEmailOnlyInviteId(invite_id: string): boolean {
  return invite_id.startsWith(EMAIL_ONLY_INVITE_PREFIX);
}

function parseEmailOnlyInviteId(invite_id: string): string {
  if (!isEmailOnlyInviteId(invite_id)) {
    throw new Error(`invite_id '${invite_id}' is not an email-only invite`);
  }
  const action_id = invite_id.slice(EMAIL_ONLY_INVITE_PREFIX.length);
  ensureUuid(action_id, "email_action_id");
  return action_id;
}

function makeEmailOnlyInviteId(action_id: string): string {
  return `${EMAIL_ONLY_INVITE_PREFIX}${action_id}`;
}

function isAlreadyCollaboratorError(err: unknown): boolean {
  return `${(err as any)?.message ?? err ?? ""}`
    .toLowerCase()
    .includes("already a collaborator");
}

async function syncProjectUsersOnHostBestEffort(
  project_id: string,
  reason: string,
): Promise<void> {
  try {
    await syncProjectUsersOnHost({ project_id });
  } catch (err) {
    logger.warn("project collaborator host sync skipped", {
      project_id,
      reason,
      err: `${err}`,
    });
  }
}

async function expirePendingCollabInvites(pool: ReturnType<typeof getPool>) {
  await pool.query(
    `UPDATE project_collab_invites
       SET status='expired', responded=COALESCE(responded, NOW()), updated=NOW()
     WHERE status='pending'
       AND created < NOW() - INTERVAL '${COLLAB_INVITE_EXPIRES_INTERVAL}'`,
  );
}

async function fetchInviteById(
  invite_id: string,
  includeEmail: boolean,
): Promise<ProjectCollabInviteRow | undefined> {
  const pool = getPool();
  const { rows } = await pool.query<ProjectCollabInviteRow>(
    `SELECT
       i.invite_id,
       i.project_id,
       p.title AS project_title,
       p.description AS project_description,
       i.inviter_account_id,
       inviter.name AS inviter_name,
       inviter.first_name AS inviter_first_name,
       inviter.last_name AS inviter_last_name,
       CASE WHEN $2::boolean THEN inviter.email_address ELSE NULL END AS inviter_email_address,
       i.invitee_account_id,
       invitee.name AS invitee_name,
       invitee.first_name AS invitee_first_name,
       invitee.last_name AS invitee_last_name,
       CASE WHEN $2::boolean THEN invitee.email_address ELSE NULL END AS invitee_email_address,
       i.status,
       i.message,
       i.responder_action,
       i.created,
       i.updated,
       i.responded,
       i.created + INTERVAL '${COLLAB_INVITE_EXPIRES_INTERVAL}' AS expires
     FROM project_collab_invites i
     LEFT JOIN projects p ON p.project_id=i.project_id
     LEFT JOIN accounts inviter ON inviter.account_id=i.inviter_account_id
     LEFT JOIN accounts invitee ON invitee.account_id=i.invitee_account_id
     WHERE i.invite_id=$1
     LIMIT 1`,
    [invite_id, includeEmail],
  );
  return rows[0];
}

async function listEmailOnlyPendingCollabInvites({
  account_id,
  project_id,
  direction,
  status,
  limit,
  includeEmail,
}: {
  account_id: string;
  project_id?: string;
  direction: ProjectCollabInviteDirection;
  status?: ProjectCollabInviteStatus;
  limit: number;
  includeEmail: boolean;
}): Promise<ProjectCollabInviteRow[]> {
  if (direction === "inbound") {
    return [];
  }
  if (status != null && status !== "pending") {
    return [];
  }
  const pool = getPool();
  const params: any[] = [includeEmail, account_id];
  const where = [
    `a.expire > NOW()`,
    `a.action ->> 'action' = 'add_to_project'`,
    `COALESCE(a.action ->> 'group', '') IN ('owner', 'collaborator')`,
    `(
      COALESCE(a.action ->> 'inviter_account_id', '') = $2::text
      OR (
        COALESCE(a.action ->> 'inviter_account_id', '') = ''
        AND EXISTS(
          SELECT 1
          FROM projects px
          WHERE px.project_id = (a.action ->> 'project_id')::uuid
            AND (px.users -> $2::text ->> 'group') IN ('owner','collaborator')
        )
      )
    )`,
  ];
  if (project_id != null) {
    params.push(project_id);
    where.push(`(a.action ->> 'project_id')::uuid = $${params.length}::uuid`);
  }
  params.push(limit);
  const sql = `SELECT
      ${`'${EMAIL_ONLY_INVITE_PREFIX}'`} || a.id::text AS invite_id,
      (a.action ->> 'project_id')::uuid AS project_id,
      p.title AS project_title,
      p.description AS project_description,
      COALESCE(
        CASE
          WHEN COALESCE(a.action ->> 'inviter_account_id', '') ~* '^[0-9a-f-]{36}$'
          THEN (a.action ->> 'inviter_account_id')::uuid
          ELSE NULL
        END,
        $2::uuid
      ) AS inviter_account_id,
      inviter.name AS inviter_name,
      inviter.first_name AS inviter_first_name,
      inviter.last_name AS inviter_last_name,
      CASE WHEN $1::boolean THEN inviter.email_address ELSE NULL END AS inviter_email_address,
      invitee.account_id AS invitee_account_id,
      invitee.name AS invitee_name,
      invitee.first_name AS invitee_first_name,
      invitee.last_name AS invitee_last_name,
      CASE
        WHEN $1::boolean THEN COALESCE(invitee.email_address, a.email_address)
        ELSE a.email_address
      END AS invitee_email_address,
      'email'::text AS invite_source,
      'pending'::text AS status,
      NULLIF(a.action ->> 'message', '') AS message,
      NULL::text AS responder_action,
      (a.expire - INTERVAL '${EMAIL_ONLY_INVITE_TTL_DAYS} days') AS created,
      (a.expire - INTERVAL '${EMAIL_ONLY_INVITE_TTL_DAYS} days') AS updated,
      NULL::timestamp AS responded,
      a.expire AS expires,
      0::int AS prior_invites_accepted,
      0::int AS prior_invites_declined,
      0::int AS shared_projects_count,
      ARRAY[]::text[] AS shared_projects_sample
    FROM account_creation_actions a
    LEFT JOIN projects p ON p.project_id = (a.action ->> 'project_id')::uuid
    LEFT JOIN accounts invitee ON lower(invitee.email_address) = lower(a.email_address)
    LEFT JOIN accounts inviter ON inviter.account_id = COALESCE(
      CASE
        WHEN COALESCE(a.action ->> 'inviter_account_id', '') ~* '^[0-9a-f-]{36}$'
        THEN (a.action ->> 'inviter_account_id')::uuid
        ELSE NULL
      END,
      $2::uuid
    )
    WHERE ${where.join(" AND ")}
      AND NOT EXISTS(
        SELECT 1
        FROM projects py
        WHERE py.project_id = (a.action ->> 'project_id')::uuid
          AND invitee.account_id IS NOT NULL
          AND (py.users -> invitee.account_id::text ->> 'group') IN ('owner','collaborator')
      )
    ORDER BY a.expire DESC
    LIMIT $${params.length}`;
  const { rows } = await pool.query<ProjectCollabInviteRow>(sql, params);
  return rows;
}

async function fetchEmailOnlyInviteByActionId({
  account_id,
  action_id,
  includeEmail,
}: {
  account_id: string;
  action_id: string;
  includeEmail: boolean;
}): Promise<ProjectCollabInviteRow | undefined> {
  const rows = await listEmailOnlyPendingCollabInvites({
    account_id,
    direction: "outbound",
    limit: 1000,
    includeEmail,
    status: "pending",
  });
  return rows.find((row) => row.invite_id === makeEmailOnlyInviteId(action_id));
}

export async function removeCollaborator({
  account_id,
  opts,
}: {
  account_id: string;
  opts: {
    account_id;
    project_id;
  };
}): Promise<void> {
  await assertLocalProjectCollaborator({
    account_id,
    project_id: opts.project_id,
  });
  // @ts-ignore
  await callback2(db().remove_collaborator_from_project, opts);
  await publishProjectAccountFeedEventsBestEffort({
    project_id: opts.project_id,
  });
}

export async function addCollaborator({
  account_id,
  opts,
}: {
  account_id: string;
  opts: AddCollaborator;
}): Promise<{ project_id?: string | string[] }> {
  if (!account_id) {
    throw Error("user must be signed in");
  }
  let projects: undefined | string | string[] = opts.project_id;
  let accounts: undefined | string | string[] = opts.account_id;
  let tokens: undefined | string | string[] = opts.token_id;
  let is_single_token = false;

  if (tokens) {
    if (!is_array(tokens)) {
      is_single_token = true;
      tokens = [tokens];
    }
    // projects will get mutated below as tokens are used
    projects = Array(tokens.length).fill("");
  }
  if (!is_array(projects)) {
    projects = [projects] as string[];
  }
  if (!is_array(accounts)) {
    accounts = [accounts];
  }

  // Security: non-admin users may only direct-add themselves.
  // Adding other collaborators must go through invite acceptance flow.
  if (!(await isAdmin(account_id))) {
    for (const target of accounts as string[]) {
      if (target !== account_id) {
        throw new Error(
          "direct collaborator add is restricted to adding yourself; send an invite instead",
        );
      }
    }
  }

  await add_collaborators_to_projects(
    db(),
    account_id,
    accounts as string[],
    projects as string[],
    tokens as string[] | undefined,
  );
  for (const project_id of projects as string[]) {
    if (project_id) {
      await publishProjectAccountFeedEventsBestEffort({ project_id });
    }
  }
  // Tokens determine the projects, and it may be useful to the client to know what
  // project they just got added to!
  let project_id;
  if (is_single_token) {
    project_id = projects[0];
  } else {
    project_id = projects;
  }
  return { project_id };
}

export async function createCollabInvite({
  account_id,
  project_id,
  invitee_account_id,
  message,
  direct,
}: {
  account_id?: string;
  project_id: string;
  invitee_account_id: string;
  message?: string;
  direct?: boolean;
}): Promise<{
  created: boolean;
  invite: ProjectCollabInviteRow;
}> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  ensureUuid(project_id, "project_id");
  ensureUuid(invitee_account_id, "invitee_account_id");
  if (invitee_account_id === account_id) {
    throw new Error("cannot invite yourself");
  }
  await assertLocalProjectCollaborator({ account_id, project_id });

  const pool = getPool();
  const includeEmail = await isAdmin(account_id);
  await expirePendingCollabInvites(pool);
  const trimmedMessage = `${message ?? ""}`.trim();
  const normalizedMessage = trimmedMessage
    ? trimmedMessage.slice(0, 512)
    : null;

  const { rows: accountRows } = await pool.query<{ account_id: string }>(
    "SELECT account_id FROM accounts WHERE account_id=$1 LIMIT 1",
    [invitee_account_id],
  );
  if (!accountRows[0]?.account_id) {
    throw new Error(`account '${invitee_account_id}' does not exist`);
  }

  const { rows: collabRows } = await pool.query<{ already: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM projects
       WHERE project_id=$1
         AND (users -> $2::text ->> 'group') IN ('owner','collaborator')
     ) AS already`,
    [project_id, invitee_account_id],
  );
  if (collabRows[0]?.already) {
    throw new Error("target account is already a collaborator");
  }

  const { rows: blockedRows } = await pool.query<{ blocked: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM project_collab_invite_blocks
       WHERE blocker_account_id=$1
         AND blocked_account_id=$2
     ) AS blocked`,
    [invitee_account_id, account_id],
  );
  if (blockedRows[0]?.blocked) {
    throw new Error(
      "invite rejected: target account has blocked invites from you",
    );
  }

  if (direct) {
    if (!includeEmail) {
      throw new Error("direct collaborator add requires admin privileges");
    }
    const database = db();
    await callback2(database.add_user_to_project, {
      project_id,
      account_id: invitee_account_id,
      group: "collaborator",
    });
    await syncProjectUsersOnHostBestEffort(
      project_id,
      "create-collab-invite-direct",
    );
    const syntheticId = uuid();
    const now = new Date();
    const expires = new Date(
      now.getTime() + COLLAB_INVITE_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
    );
    return {
      created: true,
      invite: {
        invite_id: syntheticId,
        project_id,
        inviter_account_id: account_id,
        invitee_account_id,
        status: "accepted",
        message: normalizedMessage,
        responder_action: "accept",
        created: now,
        updated: now,
        responded: now,
        expires,
      },
    };
  }

  const { rows: pendingRows } = await pool.query<{ invite_id: string }>(
    `SELECT invite_id
     FROM project_collab_invites
     WHERE project_id=$1
       AND inviter_account_id=$2
       AND invitee_account_id=$3
       AND status='pending'
     ORDER BY created DESC
     LIMIT 1`,
    [project_id, account_id, invitee_account_id],
  );
  const existingPending = pendingRows[0]?.invite_id;
  if (existingPending) {
    const invite = await fetchInviteById(existingPending, includeEmail);
    if (!invite) {
      throw new Error("failed to load existing pending invite");
    }
    return {
      created: false,
      invite,
    };
  }

  const invite_id = uuid();
  await pool.query(
    `INSERT INTO project_collab_invites
      (invite_id, project_id, inviter_account_id, invitee_account_id, status, message, created, updated)
     VALUES
      ($1, $2, $3, $4, 'pending', $5, NOW(), NOW())`,
    [invite_id, project_id, account_id, invitee_account_id, normalizedMessage],
  );
  const invite = await fetchInviteById(invite_id, includeEmail);
  if (!invite) {
    throw new Error("failed to load created invite");
  }
  return {
    created: true,
    invite,
  };
}

export async function listCollabInvites({
  account_id,
  project_id,
  direction,
  status,
  limit,
}: {
  account_id?: string;
  project_id?: string;
  direction?: ProjectCollabInviteDirection;
  status?: ProjectCollabInviteStatus;
  limit?: number;
}): Promise<ProjectCollabInviteRow[]> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  const includeEmail = await isAdmin(account_id);
  const normalizedDirection = normalizeInviteDirection(direction);
  const normalizedStatus = normalizeInviteStatus(status);
  const maxRows = Math.max(1, Math.min(1000, Number(limit ?? 200) || 200));
  const pool = getPool();
  await expirePendingCollabInvites(pool);

  const params: any[] = [includeEmail];
  const where: string[] = [];
  if (project_id) {
    ensureUuid(project_id, "project_id");
    params.push(project_id);
    where.push(`i.project_id=$${params.length}`);
  }

  params.push(account_id);
  const accountParam = `$${params.length}`;
  const otherAccountExpr = `CASE WHEN i.inviter_account_id=${accountParam}::uuid THEN i.invitee_account_id ELSE i.inviter_account_id END`;
  if (normalizedDirection === "inbound") {
    where.push(`i.invitee_account_id=${accountParam}`);
  } else if (normalizedDirection === "outbound") {
    where.push(`i.inviter_account_id=${accountParam}`);
  } else {
    where.push(
      `(i.inviter_account_id=${accountParam} OR i.invitee_account_id=${accountParam})`,
    );
  }

  if (normalizedStatus) {
    params.push(normalizedStatus);
    where.push(`i.status=$${params.length}`);
  }

  params.push(maxRows);
  const sql = `SELECT
      i.invite_id,
      i.project_id,
      p.title AS project_title,
      p.description AS project_description,
      i.inviter_account_id,
      inviter.name AS inviter_name,
      inviter.first_name AS inviter_first_name,
      inviter.last_name AS inviter_last_name,
      CASE WHEN $1::boolean THEN inviter.email_address ELSE NULL END AS inviter_email_address,
      i.invitee_account_id,
      invitee.name AS invitee_name,
      invitee.first_name AS invitee_first_name,
      invitee.last_name AS invitee_last_name,
      CASE WHEN $1::boolean THEN invitee.email_address ELSE NULL END AS invitee_email_address,
      i.status,
      i.message,
      i.responder_action,
      i.created,
      i.updated,
      i.responded,
      i.created + INTERVAL '${COLLAB_INVITE_EXPIRES_INTERVAL}' AS expires,
      (
        SELECT COUNT(*)::int
        FROM project_collab_invites h
        WHERE h.inviter_account_id=${otherAccountExpr}
          AND h.invitee_account_id=${accountParam}::uuid
          AND h.status='accepted'
      ) AS prior_invites_accepted,
      (
        SELECT COUNT(*)::int
        FROM project_collab_invites h
        WHERE h.inviter_account_id=${otherAccountExpr}
          AND h.invitee_account_id=${accountParam}::uuid
          AND h.status='declined'
      ) AS prior_invites_declined,
      (
        SELECT COUNT(*)::int
        FROM projects sp
        WHERE (sp.users -> ${accountParam}::text ->> 'group') IN ('owner','collaborator')
          AND (sp.users -> (${otherAccountExpr})::text ->> 'group') IN ('owner','collaborator')
      ) AS shared_projects_count,
      (
        SELECT COALESCE(array_agg(x.title), ARRAY[]::text[])
        FROM (
          SELECT sp.title
          FROM projects sp
          WHERE (sp.users -> ${accountParam}::text ->> 'group') IN ('owner','collaborator')
            AND (sp.users -> (${otherAccountExpr})::text ->> 'group') IN ('owner','collaborator')
            AND sp.title IS NOT NULL
            AND sp.title <> ''
          ORDER BY sp.last_edited DESC NULLS LAST
          LIMIT 3
        ) x
      ) AS shared_projects_sample
    FROM project_collab_invites i
    LEFT JOIN projects p ON p.project_id=i.project_id
    LEFT JOIN accounts inviter ON inviter.account_id=i.inviter_account_id
    LEFT JOIN accounts invitee ON invitee.account_id=i.invitee_account_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY i.created DESC
    LIMIT $${params.length}`;

  const { rows } = await pool.query<ProjectCollabInviteRow>(sql, params);
  const emailOnlyRows = await listEmailOnlyPendingCollabInvites({
    account_id,
    project_id,
    direction: normalizedDirection,
    status: normalizedStatus,
    limit: maxRows,
    includeEmail,
  });
  return [...rows, ...emailOnlyRows]
    .sort(
      (a, b) =>
        new Date(`${b.created ?? 0}`).valueOf() -
        new Date(`${a.created ?? 0}`).valueOf(),
    )
    .slice(0, maxRows);
}

export async function respondCollabInvite({
  account_id,
  invite_id,
  action,
}: {
  account_id?: string;
  invite_id: string;
  action: ProjectCollabInviteAction;
}): Promise<ProjectCollabInviteRow> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  const normalizedAction = normalizeInviteAction(action);
  const includeEmail = await isAdmin(account_id);
  if (isEmailOnlyInviteId(invite_id)) {
    if (normalizedAction !== "revoke") {
      throw new Error("email-only invites can only be revoked");
    }
    const action_id = parseEmailOnlyInviteId(invite_id);
    const existing = await fetchEmailOnlyInviteByActionId({
      account_id,
      action_id,
      includeEmail,
    });
    if (!existing) {
      throw new Error(`invite '${invite_id}' not found`);
    }
    const pool = getPool();
    const rawInviterAccountId = `${existing.inviter_account_id ?? ""}`.trim();
    if (rawInviterAccountId !== account_id && !includeEmail) {
      await assertLocalProjectCollaborator({
        account_id,
        project_id: existing.project_id,
      });
    }
    await pool.query(
      `DELETE FROM account_creation_actions
       WHERE id = $1::uuid`,
      [action_id],
    );
    const now = new Date();
    return {
      ...existing,
      status: "canceled",
      responder_action: "revoke",
      responded: now,
      updated: now,
    };
  }
  ensureUuid(invite_id, "invite_id");
  const pool = getPool();
  await expirePendingCollabInvites(pool);

  const { rows: existingRows } = await pool.query<{
    invite_id: string;
    project_id: string;
    inviter_account_id: string;
    invitee_account_id: string;
    status: string;
  }>(
    `SELECT invite_id, project_id, inviter_account_id, invitee_account_id, status
     FROM project_collab_invites
     WHERE invite_id=$1
     LIMIT 1`,
    [invite_id],
  );
  const invite = existingRows[0];
  if (!invite) {
    throw new Error(`invite '${invite_id}' not found`);
  }
  if (invite.status !== "pending") {
    throw new Error(`invite is not pending (status=${invite.status})`);
  }
  const admin = includeEmail;

  if (normalizedAction === "revoke") {
    if (invite.inviter_account_id !== account_id && !admin) {
      throw new Error("only invite sender can revoke");
    }
    await pool.query(
      `UPDATE project_collab_invites
        SET status='canceled', responder_action=$2, responded=NOW(), updated=NOW()
        WHERE invite_id=$1`,
      [invite_id, normalizedAction],
    );
    const updated = await fetchInviteById(invite_id, includeEmail);
    if (!updated) {
      throw new Error("failed to load invite response");
    }
    return updated;
  }

  if (invite.invitee_account_id !== account_id) {
    throw new Error("only invite recipient can respond");
  }

  let nextStatus: ProjectCollabInviteStatus = "declined";
  if (normalizedAction === "accept") {
    const { rows: collabRows } = await pool.query<{ already: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM projects
         WHERE project_id=$1
           AND (users -> $2::text ->> 'group') IN ('owner','collaborator')
       ) AS already`,
      [invite.project_id, account_id],
    );
    if (!collabRows[0]?.already) {
      const database = db();
      await callback2(database.add_user_to_project, {
        project_id: invite.project_id,
        account_id,
        group: "collaborator",
      });
      await syncProjectUsersOnHostBestEffort(
        invite.project_id,
        "respond-collab-invite-accept",
      );
    }
    nextStatus = "accepted";
  } else if (normalizedAction === "block") {
    await pool.query(
      `INSERT INTO project_collab_invite_blocks
        (blocker_account_id, blocked_account_id, created, updated)
       VALUES
        ($1, $2, NOW(), NOW())
       ON CONFLICT (blocker_account_id, blocked_account_id)
       DO UPDATE SET updated=EXCLUDED.updated`,
      [account_id, invite.inviter_account_id],
    );
    nextStatus = "blocked";
  } else {
    nextStatus = "declined";
  }

  await pool.query(
    `UPDATE project_collab_invites
      SET status=$2, responder_action=$3, responded=NOW(), updated=NOW()
      WHERE invite_id=$1`,
    [invite_id, nextStatus, normalizedAction],
  );

  const updated = await fetchInviteById(invite_id, includeEmail);
  if (!updated) {
    throw new Error("failed to load invite response");
  }
  return updated;
}

export async function listCollabInviteBlocks({
  account_id,
  limit,
}: {
  account_id?: string;
  limit?: number;
}): Promise<ProjectCollabInviteBlockRow[]> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  const includeEmail = await isAdmin(account_id);
  const maxRows = Math.max(1, Math.min(1000, Number(limit ?? 200) || 200));
  const pool = getPool();
  const { rows } = await pool.query<ProjectCollabInviteBlockRow>(
    `SELECT
       b.blocker_account_id,
       blocker.name AS blocker_name,
       b.blocked_account_id,
       blocked.name AS blocked_name,
       blocked.first_name AS blocked_first_name,
       blocked.last_name AS blocked_last_name,
       CASE WHEN $2::boolean THEN blocked.email_address ELSE NULL END AS blocked_email_address,
       b.created,
       b.updated
     FROM project_collab_invite_blocks b
     LEFT JOIN accounts blocker ON blocker.account_id=b.blocker_account_id
     LEFT JOIN accounts blocked ON blocked.account_id=b.blocked_account_id
     WHERE b.blocker_account_id=$1
     ORDER BY b.updated DESC
     LIMIT $3`,
    [account_id, includeEmail, maxRows],
  );
  return rows;
}

export async function unblockCollabInviteSender({
  account_id,
  blocked_account_id,
}: {
  account_id?: string;
  blocked_account_id: string;
}): Promise<{
  unblocked: boolean;
  blocker_account_id: string;
  blocked_account_id: string;
}> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  ensureUuid(blocked_account_id, "blocked_account_id");
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM project_collab_invite_blocks
     WHERE blocker_account_id=$1 AND blocked_account_id=$2`,
    [account_id, blocked_account_id],
  );
  return {
    unblocked: (result.rowCount ?? 0) > 0,
    blocker_account_id: account_id,
    blocked_account_id,
  };
}

export async function listCollaborators({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}): Promise<ProjectCollaboratorRow[]> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  ensureUuid(project_id, "project_id");
  await assertLocalProjectCollaborator({ account_id, project_id });
  const includeEmail = await isAdmin(account_id);
  const pool = getPool();
  const { rows } = await pool.query<ProjectCollaboratorRow>(
    `SELECT
       a.account_id,
       a.name,
       a.first_name,
       a.last_name,
       CASE WHEN $2::boolean THEN a.email_address ELSE NULL END AS email_address,
       a.last_active,
       (u.info ->> 'group')::text AS "group"
     FROM projects p
     CROSS JOIN LATERAL jsonb_each(p.users) AS u(account_id_text, info)
     JOIN accounts a ON a.account_id=u.account_id_text::uuid
     WHERE p.project_id=$1
       AND u.account_id_text ~* '^[0-9a-f-]{36}$'
       AND (u.info ->> 'group') IN ('owner','collaborator')
     ORDER BY
       CASE WHEN (u.info ->> 'group')='owner' THEN 0 ELSE 1 END,
       a.last_active DESC NULLS LAST,
       a.account_id`,
    [project_id, includeEmail],
  );
  return rows.filter((row) => COLLAB_GROUP_SET.has(row.group));
}

export async function listMyCollaborators({
  account_id,
  limit,
}: {
  account_id?: string;
  limit?: number;
}): Promise<MyCollaboratorRow[]> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  const includeEmail = await isAdmin(account_id);
  const maxRows = Math.max(1, Math.min(1000, Number(limit ?? 500) || 500));
  const readMode = getCollaboratorReadMode();
  if (readMode !== "off") {
    try {
      const projected = await listProjectedMyCollaboratorsForAccount({
        account_id,
        limit: maxRows,
        include_email: includeEmail,
      });
      if (readMode === "only" || projected.length > 0) {
        return projected;
      }
    } catch (err) {
      if (readMode === "only") {
        throw err;
      }
      logger.warn("projection-backed collaborator read fallback", {
        account_id,
        err: `${err}`,
      });
    }
  }
  const pool = getPool();
  const { rows } = await pool.query<MyCollaboratorRow>(
    `WITH my_projects AS (
       SELECT p.project_id, p.users
       FROM projects p
       WHERE (p.users -> $1::text ->> 'group') IN ('owner','collaborator')
     )
     SELECT
       a.account_id,
       a.name,
       a.first_name,
       a.last_name,
       CASE WHEN $2::boolean THEN a.email_address ELSE NULL END AS email_address,
       a.last_active,
       COUNT(DISTINCT mp.project_id)::int AS shared_projects
     FROM my_projects mp
     CROSS JOIN LATERAL jsonb_each(mp.users) AS u(account_id_text, info)
     JOIN accounts a ON a.account_id=u.account_id_text::uuid
     WHERE u.account_id_text ~* '^[0-9a-f-]{36}$'
       AND a.account_id <> $1::uuid
       AND (u.info ->> 'group') IN ('owner','collaborator')
     GROUP BY
       a.account_id, a.name, a.first_name, a.last_name, a.last_active,
       CASE WHEN $2::boolean THEN a.email_address ELSE NULL END
     ORDER BY shared_projects DESC, a.last_active DESC NULLS LAST, a.account_id
     LIMIT $3`,
    [account_id, includeEmail, maxRows],
  );
  return rows;
}

async function allowUrlsInEmails({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id: string;
}) {
  return (
    (await is_paying_customer(db(), account_id)) ||
    (await project_has_network_access(db(), project_id))
  );
}

export async function inviteCollaborator({
  account_id,
  opts,
}: {
  account_id: string;
  opts: {
    project_id: string;
    account_id: string;
    title?: string;
    link2proj?: string;
    replyto?: string;
    replyto_name?: string;
    email?: string;
    subject?: string;
    message?: string;
  };
}): Promise<void> {
  await assertLocalProjectCollaborator({
    account_id,
    project_id: opts.project_id,
  });
  const dbg = (...args) => logger.debug("inviteCollaborator", ...args);
  const database = db();
  try {
    await createCollabInvite({
      account_id,
      project_id: opts.project_id,
      invitee_account_id: opts.account_id,
      message: opts.message,
    });
  } catch (err) {
    if (isAlreadyCollaboratorError(err)) {
      return;
    }
    throw err;
  }

  // Everything else in this big function is about notifying the user that they
  // were added.
  if (!opts.email) {
    return;
  }

  const email_address = await getEmailAddress(opts.account_id);
  if (!email_address) {
    return;
  }
  const when_sent = await callback2(database.when_sent_project_invite, {
    project_id: opts.project_id,
    to: email_address,
  });
  if (when_sent && when_sent >= days_ago(RESEND_INVITE_INTERVAL_DAYS)) {
    return;
  }
  const settings = await callback2(database.get_server_settings_cached);
  if (!settings) {
    return;
  }
  dbg(`send_email invite to ${email_address}`);
  let subject: string;
  if (opts.subject) {
    subject = opts.subject;
  } else if (opts.replyto_name) {
    subject = `${opts.replyto_name} invited you to collaborate on the project '${opts.title}'`;
  } else {
    subject = `Invitation for collaborating in the project '${opts.title}'`;
  }

  try {
    await callback2(send_invite_email, {
      to: email_address,
      subject,
      email: opts.email,
      email_address,
      title: opts.title,
      allow_urls: await allowUrlsInEmails({
        account_id,
        project_id: opts.project_id,
      }),
      replyto: opts.replyto ?? settings.organization_email,
      replyto_name: opts.replyto_name,
      link2proj: opts.link2proj,
      settings,
    });
  } catch (err) {
    dbg(`FAILED to send email to ${email_address}  -- ${err}`);
    await callback2(database.sent_project_invite, {
      project_id: opts.project_id,
      to: email_address,
      error: `${err}`,
    });
    throw err;
  }
  // Record successful send (without error):
  await callback2(database.sent_project_invite, {
    project_id: opts.project_id,
    to: email_address,
    error: undefined,
  });
}

export async function inviteCollaboratorWithoutAccount({
  account_id,
  opts,
}: {
  account_id: string;
  opts: {
    project_id: string;
    title: string;
    link2proj: string;
    replyto?: string;
    replyto_name?: string;
    to: string;
    email: string; // body in HTML format
    subject?: string;
    message?: string;
  };
}): Promise<void> {
  await assertLocalProjectCollaborator({
    account_id,
    project_id: opts.project_id,
  });
  const dbg = (...args) =>
    logger.debug("inviteCollaboratorWithoutAccount", ...args);
  const database = db();
  const normalizedMessage = `${opts.message ?? ""}`.trim().slice(0, 512);

  if (opts.to.length > 1024) {
    throw Error(
      "Specify less recipients when adding collaborators to project.",
    );
  }

  // Prepare list of recipients
  const to: string[] = opts.to
    .replace(/\s/g, ",")
    .replace(/;/g, ",")
    .split(",")
    .filter((x) => x);

  // Helper for inviting one user by email
  const invite_user = async (email_address: string) => {
    dbg(`inviting ${email_address}`);
    if (!is_valid_email_address(email_address)) {
      throw Error(`invalid email address '${email_address}'`);
    }
    email_address = lower_email_address(email_address);
    if (email_address.length >= 128) {
      throw Error(
        `email address must be at most 128 characters: '${email_address}'`,
      );
    }

    // 1. Already have an account?
    const to_account_id = await callback2(database.account_exists, {
      email_address,
    });

    // 2. If user exists, add to project; otherwise, trigger later add
    if (to_account_id) {
      dbg(`user ${email_address} already has an account -- create invite`);
      try {
        await createCollabInvite({
          account_id,
          project_id: opts.project_id,
          invitee_account_id: to_account_id,
          message: opts.message,
        });
      } catch (err) {
        if (isAlreadyCollaboratorError(err)) {
          return;
        }
        throw err;
      }
    } else {
      dbg(
        `user ${email_address} doesn't have an account yet -- may send email (if we haven't recently)`,
      );
      await callback2(database.account_creation_actions, {
        email_address,
        action: {
          action: "add_to_project",
          group: "collaborator",
          project_id: opts.project_id,
          inviter_account_id: account_id,
          ...(normalizedMessage ? { message: normalizedMessage } : {}),
        },
        ttl: EMAIL_ONLY_INVITE_TTL_SECONDS,
      });
    }

    // 3. Has email been sent recently?
    const when_sent = await callback2(database.when_sent_project_invite, {
      project_id: opts.project_id,
      to: email_address,
    });
    if (when_sent && when_sent >= days_ago(RESEND_INVITE_INTERVAL_DAYS)) {
      // recent email -- nothing more to do
      return;
    }

    // 4. Get settings
    const settings = await callback2(database.get_server_settings_cached);
    if (!settings) {
      return;
    }

    // 5. Send email

    // Compose subject
    const subject = opts.subject ? opts.subject : "CoCalc Invitation";

    dbg(`send_email invite to ${email_address}`);
    try {
      await callback2(send_invite_email, {
        to: email_address,
        subject,
        email: opts.email,
        email_address,
        title: opts.title,
        allow_urls: await allowUrlsInEmails({
          account_id,
          project_id: opts.project_id,
        }),
        replyto: opts.replyto ?? settings.organization_email,
        replyto_name: opts.replyto_name,
        link2proj: opts.link2proj,
        settings,
      });
    } catch (err) {
      dbg(`FAILED to send email to ${email_address}  -- err=${err}`);
      await callback2(database.sent_project_invite, {
        project_id: opts.project_id,
        to: email_address,
        error: `${err}`,
      });
      throw err;
    }
    // Record successful send (without error):
    await callback2(database.sent_project_invite, {
      project_id: opts.project_id,
      to: email_address,
      error: undefined,
    });
  };

  // If any invite_user throws, its an error
  await Promise.all(to.map((email) => invite_user(email)));
}
