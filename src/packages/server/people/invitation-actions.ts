/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { isDeepStrictEqual } from "node:util";
import { escape } from "lodash";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getOwnedCollaborationResource } from "@cocalc/database/postgres/collaborators/collaborators-owner";
import { withProjectRehomeWriteFence } from "@cocalc/database/postgres/project-rehome-fence";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { assertAccountTrustedForProductAccess } from "@cocalc/server/accounts/trusted-product-access";
import { assertProjectCollaboratorInviteLimit } from "@cocalc/server/membership/project-limits";
import {
  assertCanManageProjectCollaborators,
  assertEmailInviteBatchLimit,
  assertEmailInviteCreationLimits,
  createCollabInvite,
  ensureProjectCollabInviteEmailTokenSchema,
  hashInviteEmail,
  inviteCollaboratorWithoutAccount,
  normalizeInviteMessageForAccount,
} from "@cocalc/server/projects/collaborators";
import { createInterBayPeopleActionsClient } from "@cocalc/conat/inter-bay/people-actions";
import type {
  InterBayPeopleActionsApi,
  PeopleActionInput,
  PeopleActionRoute,
  PeopleAccessInput,
  PeopleExecuteInput,
} from "@cocalc/conat/inter-bay/people-actions";
import {
  normalizePeopleInvitationPayload,
  peopleInvitationUuid,
} from "@cocalc/util/people-invitations";
import type {
  PeopleInvitationPayload,
  PeopleInvitationProjectAction,
  PeopleInvitationPreflight,
  PeopleInvitationActionReceipt,
} from "@cocalc/util/people-invitations";
import {
  DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
  viewerReadPolicyAllowsPath,
} from "@cocalc/util/project-access";
import type { ProjectViewerReadPolicy } from "@cocalc/util/project-access";
import {
  ensurePeopleActionSchema,
  peopleActionBinding,
  readPeopleAction,
  claimPeopleAction,
  finishPeopleAction,
  recoverPeopleAction,
} from "./invitation-action-store";

function reviewRequired(reason = "invitation_changed") {
  return Object.assign(
    Error(`Invitation changed: review required (${reason})`),
    {
      code: "invitation_review_required",
      reason,
    },
  );
}
function client(bay_id: string): InterBayPeopleActionsApi {
  return bay_id === getConfiguredBayId()
    ? peopleActionsControl
    : createInterBayPeopleActionsClient({
        client: getInterBayFabricClient(),
        bay_id,
      });
}
function normalize<T extends PeopleActionInput>(input: T): T {
  const account_id = peopleInvitationUuid(
    input.account_id,
    "authenticated account_id",
  );
  const payload = normalizePeopleInvitationPayload(input.payload);
  const candidate = normalizePeopleInvitationPayload({
    ...payload,
    target: undefined,
    projects: [input.action],
  }).projects[0];
  const action = payload.projects.find(
    (a) => a.project_id === candidate.project_id,
  );
  if (!action || !isDeepStrictEqual(action, candidate))
    throw Error("invitation action not in reviewed payload");
  if (
    payload.recipient.kind === "account" &&
    payload.recipient.account_id === account_id
  )
    throw reviewRequired();
  return { ...input, account_id, payload, action };
}
function normalizeAccess<T extends PeopleAccessInput>(input: T): T {
  return {
    ...normalize(input),
    child_operation_id: peopleInvitationUuid(
      input.child_operation_id,
      "child_operation_id",
    ),
  };
}
async function enabled() {
  if (
    process.env.COCALC_PRODUCT === "lite" ||
    !(await getServerSettings()).collaborators_enabled
  )
    throw Error("People invitations are unavailable on this server");
}
async function checkOwner(project_id: string, route: PeopleActionRoute) {
  const actual = await resolveProjectBay(project_id);
  if (
    !actual ||
    actual.bay_id !== getConfiguredBayId() ||
    actual.bay_id !== route?.bay_id ||
    actual.epoch !== route?.epoch
  )
    throw Error("stale invitation project-owner route");
}
async function owner<T>(
  input: PeopleActionInput,
  invoke: (
    api: InterBayPeopleActionsApi,
    route: PeopleActionRoute,
  ) => Promise<T>,
) {
  const route = await resolveProjectBay(input.action.project_id);
  if (!route) throw Error("invitation project owner unavailable");
  return invoke(client(route.bay_id), route);
}
async function checkSender(account_id: string) {
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (!home_bay_id) throw Error("invitation account home unavailable");
  await client(home_bay_id).checkSender({
    account_id,
    route: { bay_id: home_bay_id },
  });
}

type PendingInvite = {
  invite_id: string;
  project_id: string;
  inviter_account_id: string;
  invitee_account_id: string | null;
  email_hash: string | null;
  invite_role: string | null;
  read_policy: ProjectViewerReadPolicy | null;
  scope: string | null;
  context: Record<string, any> | null;
  status: string;
  message: string | null;
  invite_source: string | null;
  expires: Date | string | null;
};
// Match fetchInviteById/expirePendingCollabInvites: expires is a wire field,
// not a stored project_collab_invites column.
const INVITE_EXPIRY_SQL = `created + CASE
  WHEN invite_source IN ('email', 'course_email') THEN INTERVAL '14 days'
  ELSE INTERVAL '30 days' END`;
function context(input: PeopleActionInput) {
  return input.payload.target?.project_id === input.action.project_id
    ? { people_invitation: { version: 1, target: input.payload.target } }
    : undefined;
}
async function compatiblePending(input: PeopleActionInput, row: PendingInvite) {
  const { action, payload, account_id } = input;
  const recipient = payload.recipient;
  if (
    action.action !== "offer_access" ||
    row.project_id !== action.project_id ||
    row.inviter_account_id !== account_id ||
    row.status !== "pending" ||
    (row.expires != null && new Date(row.expires).getTime() <= Date.now()) ||
    (row.invite_role ?? "collaborator") !== action.role ||
    !isDeepStrictEqual(
      row.read_policy ??
        (action.role === "viewer"
          ? DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY
          : null),
      action.role === "viewer" ? action.read_policy : null,
    ) ||
    (row.message ?? "") !== payload.message.trim()
  )
    throw reviewRequired();
  if (recipient.kind === "account") {
    if (
      row.invitee_account_id !== recipient.account_id ||
      row.scope ||
      row.context ||
      ![null, "account"].includes(row.invite_source)
    )
      throw reviewRequired();
  } else {
    if (
      row.invitee_account_id ||
      row.email_hash !== (await hashInviteEmail(recipient.email_address)) ||
      row.scope !== "project_collab" ||
      row.invite_source !== "email" ||
      row.context?.require_invite_email_match === true ||
      !isDeepStrictEqual(
        row.context?.people_invitation,
        context(input)?.people_invitation,
      ) ||
      Object.keys(row.context ?? {}).some(
        (key) =>
          !["require_invite_email_match", "people_invitation"].includes(key),
      )
    )
      throw reviewRequired();
  }
}
async function pending(
  input: PeopleActionInput,
): Promise<PendingInvite | undefined> {
  const recipient = input.payload.recipient;
  const rows = (
    await getPool().query(
      `SELECT *, ${INVITE_EXPIRY_SQL} AS expires FROM project_collab_invites
    WHERE project_id=$1 AND status='pending' AND (${INVITE_EXPIRY_SQL})>now()
    AND ${recipient.kind === "account" ? "invitee_account_id=$2::uuid" : "email_hash=$2"}
    ORDER BY created DESC LIMIT 2`,
      [
        input.action.project_id,
        recipient.kind === "account"
          ? recipient.account_id
          : await hashInviteEmail(recipient.email_address),
      ],
    )
  ).rows;
  if (rows.length > 1) throw reviewRequired();
  if (rows[0]) await compatiblePending(input, rows[0]);
  return rows[0];
}
async function beforeReuse(input: PeopleActionInput, invite_id: string) {
  const row = (
    await getPool().query(
      `SELECT *, ${INVITE_EXPIRY_SQL} AS expires FROM project_collab_invites WHERE invite_id=$1`,
      [invite_id],
    )
  ).rows[0];
  if (!row) throw reviewRequired();
  await compatiblePending(input, row);
}

async function localPreflight(
  input: PeopleActionInput,
  route: PeopleActionRoute,
): Promise<PeopleInvitationPreflight> {
  await enabled();
  await checkOwner(input.action.project_id, route);
  await checkSender(input.account_id);
  await ensureProjectCollabInviteEmailTokenSchema();
  const { account_id, action, payload } = input;
  const project = (
    await getPool().query(
      `SELECT users,deleted,owning_bay_id FROM projects WHERE project_id=$1`,
      [action.project_id],
    )
  ).rows[0];
  if (
    !project ||
    project.deleted ||
    !["owner", "collaborator"].includes(project.users?.[account_id]?.group)
  )
    throw reviewRequired();
  await normalizeInviteMessageForAccount({
    account_id,
    message: payload.message,
  });
  // Existence uses the same stable typed resolver as opening content, never a path supplied by the caller.
  const target =
    payload.target?.project_id === action.project_id
      ? payload.target
      : undefined;
  const resource = target
    ? await getOwnedCollaborationResource(target, account_id, {
        owning_bay_id: route.bay_id,
      })
    : undefined;
  if (target && !resource) throw reviewRequired();
  const recipient = payload.recipient;
  let sufficient = false;
  const warnings: string[] = [];
  if (recipient.kind === "account") {
    const account = await getClusterAccountById(recipient.account_id);
    if (!account || account.banned) throw reviewRequired();
    const blocked = (
      await getPool().query(
        `SELECT 1 FROM project_collab_invite_blocks WHERE blocker_account_id=$1 AND blocked_account_id=$2 LIMIT 1`,
        [recipient.account_id, account_id],
      )
    ).rows.length;
    if (blocked) throw reviewRequired();
    const member = project.users?.[recipient.account_id];
    sufficient = ["owner", "collaborator"].includes(member?.group);
    if (member?.group === "viewer") {
      const policy =
        member.read_policy ?? DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY;
      const readable =
        !resource ||
        viewerReadPolicyAllowsPath({ policy, path: resource.chat_path });
      // People content opening currently requires collaborator membership, even if the backing chat is readable.
      sufficient =
        !target &&
        readable &&
        (action.action === "notify" ||
          (action.role === "viewer" &&
            isDeepStrictEqual(policy, action.read_policy)));
      if (target) warnings.push("content_requires_collaborator");
      if (
        !sufficient &&
        action.action === "offer_access" &&
        action.role === "viewer"
      )
        throw reviewRequired(
          target ? "content_requires_collaborator" : "viewer_policy_changed",
        );
    }
  }
  if (action.action === "notify" && !sufficient)
    throw reviewRequired(
      warnings.includes("content_requires_collaborator")
        ? "content_requires_collaborator"
        : "recipient_access_changed",
    );
  if (action.action === "offer_access" && !sufficient) {
    // Notifying an existing collaborator is permission-free, even when this
    // project reserves membership management for its owner.
    try {
      await assertCanManageProjectCollaborators({
        account_id,
        project_id: action.project_id,
        action: "invite collaborators",
      });
    } catch (err) {
      if (
        /^only project (owners|collaborators) can /.test(
          `${(err as Error).message}`,
        )
      )
        throw reviewRequired("sender_cannot_manage_access");
      throw err;
    }
    if (target && action.role === "viewer")
      throw reviewRequired("content_requires_collaborator");
    const existing = await pending(input);
    if (existing) warnings.push("compatible_pending_offer");
    else {
      if (action.role === "collaborator")
        await assertProjectCollaboratorInviteLimit({
          project_id: action.project_id,
        });
      if (recipient.kind === "email") {
        await assertEmailInviteBatchLimit({ account_id, recipientCount: 1 });
        await assertEmailInviteCreationLimits({
          account_id,
          project_id: action.project_id,
          recipientCount: 1,
          scope: "project_collab",
        });
      }
    }
  }
  return {
    project_id: action.project_id,
    action: action.action,
    recipient_access:
      recipient.kind === "email"
        ? "unknown"
        : sufficient
          ? "sufficient"
          : "insufficient",
    warnings,
  };
}

async function inspectLocal(
  input: PeopleAccessInput,
  route: PeopleActionRoute,
) {
  await checkOwner(input.action.project_id, route);
  await ensurePeopleActionSchema();
  const binding = await peopleActionBinding(input);
  return withProjectRehomeWriteFence({
    project_id: input.action.project_id,
    action: "inspect people invitation",
    fn: async (db) => {
      await checkOwner(input.action.project_id, route);
      const receipt = await readPeopleAction(input, binding);
      if (
        !receipt ||
        receipt.status !== "unknown" ||
        input.action.action !== "offer_access"
      )
        return receipt;
      // Only this operation's deterministic ID is evidence, never a merely similar pending offer.
      const row = (
        await getPool().query(
          "SELECT invite_id FROM project_collab_invites WHERE invite_id=$1 AND project_id=$2 AND inviter_account_id=$3",
          [input.child_operation_id, input.action.project_id, input.account_id],
        )
      ).rows[0];
      if (!row) return receipt;
      return recoverPeopleAction(
        input,
        binding,
        {
          ...receipt,
          status: "created" as const,
          access_invite_id: row.invite_id,
          reason: "access_created_delivery_unconfirmed",
          delivery:
            input.payload.recipient.kind === "email"
              ? [
                  {
                    channel: "email" as const,
                    status: input.payload.channels.email
                      ? ("unknown" as const)
                      : ("suppressed" as const),
                  },
                ]
              : [],
        },
        db,
      );
    },
  });
}

async function executeLocal(
  input: PeopleExecuteInput,
  route: PeopleActionRoute,
): Promise<PeopleInvitationActionReceipt> {
  const existing = await inspectLocal(input, route);
  if (existing) return existing;
  const binding = await peopleActionBinding(input);
  const base = {
    child_operation_id: input.child_operation_id,
    project_id: input.action.project_id,
    action: input.action.action,
    delivery: [],
  };
  const expired = () =>
    !Number.isFinite(input.authorization_expires_at) ||
    input.authorization_expires_at <= Date.now();
  if (expired())
    return {
      ...base,
      status: "review_required",
      reason: "authorization_expired",
    };
  try {
    await localPreflight(input, route);
  } catch (err) {
    if ((err as { code?: string }).code === "invitation_review_required")
      return {
        ...base,
        status: "review_required",
        reason: (err as { reason?: string }).reason ?? "invitation_changed",
      };
    throw err;
  }
  if (expired())
    return {
      ...base,
      status: "review_required",
      reason: "authorization_expired",
    };
  const claimed = await claimPeopleAction(input, binding, () =>
    checkOwner(input.action.project_id, route),
  );
  if (!claimed) return (await inspectLocal(input, route))!;
  try {
    // Recheck after durable admission: admission is not a grant of continuing authority.
    const check = await localPreflight(input, route);
    if (expired())
      return await finishPeopleAction(input, binding, {
        ...base,
        status: "review_required",
        reason: "authorization_expired",
      });
    if (check.recipient_access === "sufficient")
      return await finishPeopleAction(input, binding, {
        ...base,
        status: "notified",
      });
    if (input.action.action !== "offer_access") throw reviewRequired();
    const prior = await pending(input);
    if (prior)
      return await finishPeopleAction(input, binding, {
        ...base,
        status: "reused",
        access_invite_id: prior.invite_id,
        delivery:
          input.payload.recipient.kind === "email"
            ? [
                {
                  channel: "email",
                  status: "suppressed",
                  reason: "existing_pending_offer",
                },
              ]
            : [],
      });
    const { action, payload, account_id } = input;
    const options = {
      trustedProductAccessChecked: true,
      invite_id: input.child_operation_id,
      beforeReuse: (invite_id: string) => beforeReuse(input, invite_id),
    };
    if (payload.recipient.kind === "account") {
      const result = await createCollabInvite(
        {
          account_id,
          project_id: action.project_id,
          invitee_account_id: payload.recipient.account_id,
          message: payload.message,
          invite_role: action.role,
          read_policy: action.read_policy,
        },
        options,
      );
      return await finishPeopleAction(input, binding, {
        ...base,
        status: result.created ? "created" : "reused",
        access_invite_id: result.invite.invite_id,
      });
    }
    const authored = [payload.target?.label, payload.message]
      .filter(Boolean)
      .map((text) => `<p>${escape(text).replace(/\r?\n/g, "<br>")}</p>`)
      .join("");
    const result = await inviteCollaboratorWithoutAccount(
      {
        account_id,
        opts: {
          project_id: action.project_id,
          title: "CoCalc project",
          link2proj: "",
          to: payload.recipient.email_address,
          email: `<p>You have been invited to collaborate on a CoCalc project.</p>${authored}`,
          message: payload.message,
          send_email: payload.channels.email,
          invite_context: context(input),
          invite_role: action.role,
          read_policy: action.read_policy,
        },
      },
      options,
    );
    const invite = result.invites[0];
    if (!invite) throw Error("missing invitation receipt");
    return await finishPeopleAction(input, binding, {
      ...base,
      status:
        invite.invite_id === input.child_operation_id ? "created" : "reused",
      access_invite_id: invite.invite_id,
      delivery: [
        {
          channel: "email",
          status: result.email_sent ? "sent" : "suppressed",
          ...(result.email_blocked_reason
            ? { reason: result.email_blocked_reason }
            : {}),
        },
      ],
    });
  } catch (err) {
    if ((err as { code?: string }).code === "invitation_review_required")
      return finishPeopleAction(input, binding, {
        ...base,
        status: "review_required",
        reason: (err as { reason?: string }).reason ?? "invitation_changed",
      });
    // The legacy helper may already have committed or sent mail. Preserve uncertainty.
    return (await inspectLocal(input, route))!;
  }
}

export async function preflightPeopleInvitationAction(
  account_id: string,
  payload: PeopleInvitationPayload,
  action: PeopleInvitationProjectAction,
) {
  const input = normalize({ account_id, payload, action });
  return owner(input, (api, route) => api.preflight({ ...input, route }));
}
export async function inspectPeopleInvitationAccess(value: PeopleAccessInput) {
  const input = normalizeAccess(value);
  return owner(input, (api, route) => api.inspect({ ...input, route }));
}
export async function executePeopleInvitationAccess(value: PeopleExecuteInput) {
  const input = normalizeAccess(value);
  return owner(input, (api, route) => api.execute({ ...input, route }));
}

export const peopleActionsControl: InterBayPeopleActionsApi = {
  async checkSender({ account_id, route }) {
    peopleInvitationUuid(account_id, "account_id");
    await enabled();
    const { home_bay_id } = await resolveAccountHomeBay({ account_id });
    if (home_bay_id !== getConfiguredBayId() || route.bay_id !== home_bay_id)
      throw Error("stale invitation sender-home route");
    const row = (
      await getPool().query(
        "SELECT deleted,banned FROM accounts WHERE account_id=$1",
        [account_id],
      )
    ).rows[0];
    if (!row || row.deleted || row.banned) throw reviewRequired();
    await assertAccountTrustedForProductAccess(
      account_id,
      "invite collaborators",
    );
  },
  preflight: (input) => localPreflight(normalize(input), input.route),
  inspect: (input) => inspectLocal(normalizeAccess(input), input.route),
  execute: (input) => executeLocal(normalizeAccess(input), input.route),
};
