/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { db } from "@cocalc/database";
import getPool from "@cocalc/database/pool";
import { withProjectRehomeWriteFence } from "@cocalc/database/postgres/project-rehome-fence";
import type {
  ProjectCollabInviteResendRequest,
  ProjectCollabInviteResendResult,
} from "@cocalc/conat/hub/api/projects";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import { send_invite_email } from "@cocalc/server/hub/email";
import { callback2 } from "@cocalc/util/async-utils";
import { is_valid_uuid_string } from "@cocalc/util/misc";
import {
  allowUrlsInEmails,
  assertCanManageProjectCollaborators,
  canSendInviteEmail,
  decryptInviteValue,
  emailUnavailableFromSendMessage,
  ensureProjectCollabInviteEmailTokenSchema,
  getInviteEmailResendCutoff,
  getInvitePolicyAccountId,
  inviteUrl,
} from "./collaborators";

type Request = ProjectCollabInviteResendRequest & { account_id: string };
type Result = ProjectCollabInviteResendResult;
type Queryable = Parameters<
  Parameters<typeof withProjectRehomeWriteFence>[0]["fn"]
>[0];
type Invite = {
  status: string;
  expired: boolean;
  invite_source: string | null;
  inviter_account_id: string;
  invitee_account_id: string | null;
  scope: string | null;
  context: Record<string, unknown> | null;
  message: string | null;
  email_ciphertext: string | null;
  token_ciphertext: string | null;
  last_sent: Date | null;
};

let schemaReady: Promise<void> | undefined;
export async function ensurePeopleInviteResendSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureProjectCollabInviteEmailTokenSchema();
    // No email, recoverable token, session credential, or provider error in receipts.
    await getPool()
      .query(`CREATE TABLE IF NOT EXISTS people_invite_resend_operations (
      account_id UUID NOT NULL,
      operation_id UUID NOT NULL,
      project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      invite_id UUID NOT NULL REFERENCES project_collab_invites(invite_id) ON DELETE CASCADE,
      result JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_id, operation_id)
    )`);
    await getPool()
      .query(`CREATE INDEX IF NOT EXISTS people_invite_resend_invite_idx
      ON people_invite_resend_operations(project_id, invite_id)`);
  })().catch((err) => {
    schemaReady = undefined;
    throw err;
  });
  await schemaReady;
}

function result(opts: Request, reason?: Result["reason"]): Result {
  return {
    project_id: opts.project_id,
    invite_id: opts.invite_id,
    operation_id: opts.operation_id,
    status:
      reason === "delivery_unknown" ? "unknown" : reason ? "not_sent" : "sent",
    email_sent: reason === "delivery_unknown" ? null : !reason,
    ...(reason ? { reason } : {}),
  };
}

async function authorize(opts: Request): Promise<void> {
  // Original authorship is not continuing authority, and viewers cannot manage.
  await assertLocalProjectCollaborator(opts);
  await assertCanManageProjectCollaborators({
    ...opts,
    action: "resend invitations",
  });
}

async function loadInvite(client: Queryable, opts: Request): Promise<Invite> {
  const project = await client.query(
    "SELECT project_id FROM projects WHERE project_id=$1 AND deleted IS NOT TRUE FOR SHARE",
    [opts.project_id],
  );
  if (!project.rows.length) throw Error("project not found");
  // Lock the current management policy through provider submission, rather than
  // relying on the earlier home-bay or pre-admission authorization snapshot.
  await authorize(opts);
  const { rows } = await client.query(
    `SELECT status, invite_source, inviter_account_id, invitee_account_id,
      scope, context, message, email_ciphertext, token_ciphertext, last_sent,
      created < NOW() - CASE WHEN invite_source IN ('email', 'course_email')
        THEN INTERVAL '14 days' ELSE INTERVAL '30 days' END AS expired
     FROM project_collab_invites WHERE project_id=$1 AND invite_id=$2 FOR UPDATE`,
    [opts.project_id, opts.invite_id],
  );
  if (!rows[0]) throw Error("invitation not found in the specified project");
  return rows[0];
}

async function ineligible(
  client: Queryable,
  opts: Request,
  invite: Invite,
): Promise<Result["reason"]> {
  if (invite.status !== "pending") return "not_pending";
  if (invite.expired) return "expired";
  // Course batches retain their existing delivery workflow. Account invitations
  // have no recoverable bearer link and must not be converted into email grants.
  if (
    invite.invite_source !== "email" ||
    invite.scope !== "project_collab" ||
    !invite.email_ciphertext ||
    !invite.token_ciphertext
  )
    return "unsupported_invite";
  if (invite.invitee_account_id) {
    const { rows } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM project_collab_invite_blocks
         WHERE blocker_account_id=$1 AND blocked_account_id=ANY($2::uuid[])) AS blocked,
       users -> $1::text ->> 'group' AS recipient_role
       FROM projects WHERE project_id=$3`,
      [
        invite.invitee_account_id,
        [opts.account_id, invite.inviter_account_id],
        opts.project_id,
      ],
    );
    if (rows[0]?.blocked) return "recipient_blocked";
    if (["owner", "collaborator"].includes(rows[0]?.recipient_role))
      return "already_has_access";
  }
  return undefined;
}

async function save(
  client: Queryable,
  opts: Request,
  receipt: Result,
): Promise<Result> {
  await client.query(
    `UPDATE people_invite_resend_operations SET result=$3::jsonb, updated_at=NOW()
     WHERE account_id=$1 AND operation_id=$2`,
    [opts.account_id, opts.operation_id, JSON.stringify(receipt)],
  );
  return receipt;
}

/** Project-owner service only; the public handler requires a bound human session. */
export async function resendPeopleInviteLocal(opts: Request): Promise<Result> {
  for (const key of [
    "account_id",
    "project_id",
    "invite_id",
    "operation_id",
  ] as const) {
    if (!is_valid_uuid_string(opts[key])) throw Error(`invalid ${key}`);
  }
  await authorize(opts);
  await ensurePeopleInviteResendSchema();
  const fence = <T>(fn: (client: Queryable) => Promise<T>) =>
    withProjectRehomeWriteFence({
      project_id: opts.project_id,
      action: "resend invitation",
      fn,
    });
  const admitted = await fence(
    async (client): Promise<{ receipt: Result; send: boolean }> => {
      await authorize(opts);
      const invite = await loadInvite(client, opts);
      const { rows } = await client.query(
        `SELECT project_id, invite_id, result FROM people_invite_resend_operations
       WHERE account_id=$1 AND operation_id=$2`,
        [opts.account_id, opts.operation_id],
      );
      if (rows[0]) {
        if (
          rows[0].project_id !== opts.project_id ||
          rows[0].invite_id !== opts.invite_id
        ) {
          throw Error(
            "resend operation_id is already bound to another invitation",
          );
        }
        return { receipt: rows[0].result, send: false };
      }
      let reason = await ineligible(client, opts, invite);
      if (!reason) {
        const unresolved = await client.query(
          `SELECT 1 FROM people_invite_resend_operations WHERE project_id=$1 AND invite_id=$2
         AND result->>'status'='unknown' LIMIT 1`,
          [opts.project_id, opts.invite_id],
        );
        // This new operation has definitely not submitted anything. An earlier
        // unresolved attempt keeps the invite in cooldown until reconciled.
        if (unresolved.rows.length) reason = "cooldown";
      }
      const receipt = result(opts, reason ?? "delivery_unknown");
      await client.query(
        `INSERT INTO people_invite_resend_operations(account_id, operation_id, project_id, invite_id, result)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          opts.account_id,
          opts.operation_id,
          opts.project_id,
          opts.invite_id,
          JSON.stringify(receipt),
        ],
      );
      return { receipt, send: !reason };
    },
  );
  if (!admitted.send) return admitted.receipt;

  // Admission is committed before provider I/O. A crash after submission leaves
  // unknown, never an absent receipt which a retry could submit a second time.
  return fence(async (client) => {
    await authorize(opts);
    const invite = await loadInvite(client, opts);
    const reason = await ineligible(client, opts, invite);
    if (reason) return save(client, opts, result(opts, reason));
    const policyAccountId = await getInvitePolicyAccountId({
      account_id: opts.account_id,
      project_id: opts.project_id,
      context: invite.context ?? undefined,
      scope: invite.scope ?? undefined,
    });
    if (!(await canSendInviteEmail(policyAccountId))) {
      return save(client, opts, result(opts, "tier_disallows_email"));
    }
    const email = await decryptInviteValue(
      "project_collab_invites.email",
      invite.email_ciphertext!,
    );
    const database = db();
    const previous = await callback2<Date | undefined>(
      database.when_sent_project_invite,
      {
        project_id: opts.project_id,
        to: email,
      },
    );
    const cutoff = await getInviteEmailResendCutoff(policyAccountId);
    if (
      (previous && new Date(previous) >= cutoff) ||
      (invite.last_sent && new Date(invite.last_sent) >= cutoff)
    ) {
      return save(client, opts, result(opts, "cooldown"));
    }
    const settings = await callback2(database.get_server_settings_cached);
    if (!settings)
      return save(client, opts, result(opts, "email_not_configured"));
    const token = await decryptInviteValue(
      "project_collab_invites.token",
      invite.token_ciphertext!,
    );
    const link = await inviteUrl({ token });
    const allow_urls = await allowUrlsInEmails({
      account_id: policyAccountId,
      project_id: opts.project_id,
    });
    let sendMessage: string | undefined;
    try {
      sendMessage = await callback2<string | undefined>(send_invite_email, {
        to: email,
        email_address: email,
        subject: "CoCalc collaboration invitation reminder",
        email:
          invite.message ||
          "You have a pending invitation to collaborate on CoCalc.",
        title: "CoCalc project",
        link2proj: link,
        replyto: settings.organization_email,
        replyto_name: settings.organization_name,
        allow_urls,
        settings,
      });
    } catch {
      // Provider exceptions may follow successful submission. Never claim failure
      // or persist potentially sensitive provider errors as user-visible receipts.
      return admitted.receipt;
    }
    if (`${sendMessage ?? ""}`.trim()) {
      return save(
        client,
        opts,
        result(
          opts,
          emailUnavailableFromSendMessage(sendMessage)
            ? "email_not_configured"
            : "tier_disallows_email",
        ),
      );
    }
    await client.query(
      `UPDATE project_collab_invites SET last_sent=NOW(),
       resend_count=COALESCE(resend_count,0)+1, updated=NOW()
       WHERE project_id=$1 AND invite_id=$2`,
      [opts.project_id, opts.invite_id],
    );
    // Match sent_project_invite's legacy cooldown record on this transaction's
    // connection: the legacy helper updates projects using another connection,
    // which would deadlock against our management-policy row lock.
    await client.query(
      `UPDATE projects SET invite=COALESCE(invite,'{}'::jsonb) ||
       jsonb_build_object($2::text,jsonb_build_object('time',NOW())) WHERE project_id=$1`,
      [opts.project_id, email],
    );
    return save(client, opts, result(opts));
  });
}
