/*
Add, remove and invite collaborators on projects.
*/

import { db } from "@cocalc/database";
import getPool from "@cocalc/database/pool";
import { callback2 } from "@cocalc/util/async-utils";
import isCollaborator from "@cocalc/server/projects/is-collaborator";
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

const logger = getLogger("project:collaborators");
const COLLAB_GROUPS = ["owner", "collaborator"] as const;
const COLLAB_GROUP_SET = new Set<string>(COLLAB_GROUPS);
const INVITE_STATUS_SET = new Set<string>([
  "pending",
  "accepted",
  "declined",
  "blocked",
  "canceled",
]);

function normalizeInviteDirection(
  value?: ProjectCollabInviteDirection,
): ProjectCollabInviteDirection {
  const direction = `${value ?? "all"}`.trim().toLowerCase();
  if (direction === "inbound" || direction === "outbound" || direction === "all") {
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
    `invalid status '${value}' (expected pending, accepted, declined, blocked, or canceled)`,
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
       i.responded
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
  if (!(await isCollaborator({ account_id, project_id: opts.project_id }))) {
    throw Error("user must be a collaborator");
  }
  // @ts-ignore
  await callback2(db().remove_collaborator_from_project, opts);
}

export async function addCollaborator({
  account_id,
  opts,
}: {
  account_id: string;
  opts: AddCollaborator;
}): Promise<{ project_id?: string | string[] }> {
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

  await add_collaborators_to_projects(
    db(),
    account_id,
    accounts as string[],
    projects as string[],
    tokens as string[] | undefined,
  );
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
  if (!(await isCollaborator({ account_id, project_id }))) {
    throw new Error("user must be a collaborator");
  }

  const pool = getPool();
  const includeEmail = await isAdmin(account_id);
  const trimmedMessage = `${message ?? ""}`.trim();
  const normalizedMessage = trimmedMessage ? trimmedMessage.slice(0, 512) : null;

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
    throw new Error("invite rejected: target account has blocked invites from you");
  }

  if (direct) {
    const database = db();
    await callback2(database.add_user_to_project, {
      project_id,
      account_id: invitee_account_id,
      group: "collaborator",
    });
    await syncProjectUsersOnHost({ project_id });
    const syntheticId = uuid();
    const now = new Date();
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

  const params: any[] = [includeEmail];
  const where: string[] = [];
  if (project_id) {
    ensureUuid(project_id, "project_id");
    params.push(project_id);
    where.push(`i.project_id=$${params.length}`);
  }

  params.push(account_id);
  const accountParam = `$${params.length}`;
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
      i.responded
    FROM project_collab_invites i
    LEFT JOIN projects p ON p.project_id=i.project_id
    LEFT JOIN accounts inviter ON inviter.account_id=i.inviter_account_id
    LEFT JOIN accounts invitee ON invitee.account_id=i.invitee_account_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY i.created DESC
    LIMIT $${params.length}`;

  const pool = getPool();
  const { rows } = await pool.query<ProjectCollabInviteRow>(sql, params);
  return rows;
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
  ensureUuid(invite_id, "invite_id");
  const normalizedAction = normalizeInviteAction(action);
  const includeEmail = await isAdmin(account_id);
  const pool = getPool();

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
      await syncProjectUsersOnHost({ project_id: invite.project_id });
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
  if (!(await isCollaborator({ account_id, project_id }))) {
    throw new Error("user must be a collaborator");
  }
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
  };
}): Promise<void> {
  if (!(await isCollaborator({ account_id, project_id: opts.project_id }))) {
    throw Error("user must be a collaborator");
  }
  const dbg = (...args) => logger.debug("inviteCollaborator", ...args);
  const database = db();

  // Actually add user to project
  await callback2(database.add_user_to_project, {
    project_id: opts.project_id,
    account_id: opts.account_id,
    group: "collaborator", // in future: "invite_collaborator"
  });
  await syncProjectUsersOnHost({ project_id: opts.project_id });

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
  };
}): Promise<void> {
  if (!(await isCollaborator({ account_id, project_id: opts.project_id }))) {
    throw Error("user must be a collaborator");
  }
  const dbg = (...args) =>
    logger.debug("inviteCollaboratorWithoutAccount", ...args);
  const database = db();

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
      dbg(`user ${email_address} already has an account -- add directly`);
      await callback2(database.add_user_to_project, {
        project_id: opts.project_id,
        account_id: to_account_id,
        group: "collaborator",
      });
      await syncProjectUsersOnHost({ project_id: opts.project_id });
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
        },
        ttl: 60 * 60 * 24 * 14,
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
