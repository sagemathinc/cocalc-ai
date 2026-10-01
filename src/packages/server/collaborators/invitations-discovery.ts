/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash } from "node:crypto";
import { withProjectRehomeWriteFence } from "@cocalc/database/postgres/project-rehome-fence";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getOwnedCollaborationResource } from "@cocalc/database/postgres/collaborators/collaborators-owner";
import { createInterBayCollaboratorsClient } from "@cocalc/conat/inter-bay/collaborators";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { searchClusterAccounts } from "@cocalc/server/inter-bay/accounts";
import { resolveUsernameOwner } from "@cocalc/server/accounts/usernames";
import { getNonAdminUserSearchRequest } from "@cocalc/server/accounts/user-search-policy";
import {
  ensureProjectCollabInviteEmailTokenSchema,
  hashInviteEmail,
} from "@cocalc/server/projects/collaborators";
import {
  listPeopleContacts,
  getPeopleContact,
} from "@cocalc/server/people/api";
import {
  peopleHome,
  withPeopleAccount,
  encodePeopleCursor,
  decodePeopleCursor,
} from "@cocalc/server/people/common";
import {
  normalizePeopleInvitationPayload,
  peopleInvitationUuid,
} from "@cocalc/util/people-invitations";
import type { PeopleInvitationRecipient } from "@cocalc/util/people-invitations";
import type {
  ResolveInvitationRecipientInput,
  ResolveInvitationRecipientResult,
  ListInvitationProjectsInput,
  ListInvitationProjectsResult,
  InvitationDiscoveryRecipient,
  InvitationDiscoveryProject,
  InspectInvitationProjectInput,
} from "@cocalc/util/people-invitation-discovery";
import {
  isProjectCollaboratorRole,
  normalizeProjectUserRole,
} from "@cocalc/util/project-access";
import type { ProjectUserInfo } from "@cocalc/util/project-access";
import type { ProjectViewerReadPolicy } from "@cocalc/util/project-access";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";
import {
  is_valid_email_address,
  lower_email_address,
  isValidUUID,
} from "@cocalc/util/misc";

const PAGE_SIZE = 25;
const RECIPIENT_LIMIT = 20;
const VALIDATION_PROJECT = "00000000-0000-4000-8000-000000000001";
type PendingOffer = {
  invite_role: "collaborator" | "viewer" | null;
  read_policy: ProjectViewerReadPolicy | null;
};

function text(value: unknown, max = 200): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    throw Error("invalid invitation search query");
  return value.trim();
}
async function enabled() {
  if (
    process.env.COCALC_PRODUCT === "lite" ||
    !(await getServerSettings()).collaborators_enabled
  )
    throw Error("People invitations are unavailable on this server");
}
async function home(account_id: unknown): Promise<string> {
  await enabled();
  const id = peopleInvitationUuid(account_id, "authenticated account_id");
  if ((await peopleHome(id)) !== getConfiguredBayId())
    throw Error("stale invitation account-home route");
  return id;
}

/** Email-shaped input is an authored recipient, never an account-existence oracle. */
export async function resolveInvitationRecipientLocal(
  input: ResolveInvitationRecipientInput,
): Promise<ResolveInvitationRecipientResult> {
  const account_id = await home(input.account_id);
  const query = text(input.query, 254);
  if (is_valid_email_address(query)) {
    const email_address = lower_email_address(query);
    return {
      recipients: [{ kind: "email", email_address, label: email_address }],
      notice:
        "Invite this email address. Account existence has not been checked.",
    };
  }
  const username = query.startsWith("@") ? query.slice(1) : query;
  if (username.includes("@") || query.includes(","))
    return {
      recipients: [],
      notice: "Enter a name, exact username, or one complete email address.",
    };
  if (query.length > 200) throw Error("invalid invitation search query");
  const contacts = await listPeopleContacts({
    account_id,
    search: query,
    limit: RECIPIENT_LIMIT,
  });
  const recipients: InvitationDiscoveryRecipient[] = [];
  const seen = new Set<string>();
  function add(recipient: InvitationDiscoveryRecipient) {
    const key =
      recipient.kind === "account"
        ? `account:${recipient.account_id}`
        : `email:${recipient.email_address}`;
    if (seen.has(key) || recipients.length >= RECIPIENT_LIMIT) return;
    seen.add(key);
    recipients.push(recipient);
  }
  for (const contact of contacts.items) {
    if (contact.archived) continue;
    if (
      contact.linked_account_id &&
      contact.link_provenance === "explicit_account"
    ) {
      if (contact.linked_account_id === account_id) continue;
      add({
        kind: "account",
        account_id: contact.linked_account_id,
        person_id: contact.person_id,
        label: contact.display_label || "Contact",
      });
    } else if (contact.email) {
      add({
        kind: "email",
        email_address: contact.email,
        person_id: contact.person_id,
        label: contact.display_label || contact.email,
      });
    }
  }
  if (username.length >= 2 && !isValidUUID(username)) {
    if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(username)) {
      try {
        const owner = await resolveUsernameOwner(username);
        if (owner.account_id !== account_id)
          add({
            kind: "account",
            account_id: owner.account_id,
            label: owner.username || username,
            ...(owner.username ? { username: owner.username } : {}),
          });
      } catch {
        // A missing exact username does not prevent permitted name/contact results.
      }
    }
    if (!query.startsWith("@")) {
      const request = await getNonAdminUserSearchRequest({
        query,
        limit: RECIPIENT_LIMIT,
      });
      if (
        request.kind === "text" &&
        !request.email_queries.length &&
        request.limit > 0
      ) {
        const accounts = await searchClusterAccounts({
          query: request.normalized,
          limit: request.limit,
          admin: false,
          only_email: false,
        });
        for (const account of accounts) {
          if (account.account_id === account_id || account.banned) continue;
          add({
            kind: "account",
            account_id: account.account_id,
            label: displayNameFromAccount(account) || "CoCalc account",
          });
        }
      }
    }
  }
  return {
    recipients,
    ...(contacts.next_cursor || recipients.length === RECIPIENT_LIMIT
      ? {
          notice:
            "Showing a bounded selection. Refine your search for more people.",
        }
      : {}),
  };
}

function normalizeSelection(input: ListInvitationProjectsInput) {
  const r = input.recipient;
  if (!r || typeof r !== "object") throw Error("invalid invitation recipient");
  // UI labels are presentation only; only canonical identity reaches owner RPCs.
  const recipient = {
    kind: r.kind,
    ...(r.kind === "account"
      ? { account_id: r.account_id }
      : { email_address: r.email_address }),
    ...(r.person_id ? { person_id: r.person_id } : {}),
  };
  return normalizePeopleInvitationPayload({
    recipient,
    target: input.target,
    projects: [
      {
        project_id: input.target?.project_id ?? VALIDATION_PROJECT,
        action: "offer_access",
        role: "collaborator",
      },
    ],
    message: "",
    channels: { email: false, notification: false },
  });
}
async function checkContact(
  account_id: string,
  recipient: PeopleInvitationRecipient,
) {
  if (!recipient.person_id) return;
  const contact = await getPeopleContact({
    account_id,
    person_id: recipient.person_id,
  });
  if (
    !contact ||
    contact.archived ||
    (recipient.kind === "account"
      ? contact.link_provenance !== "explicit_account" ||
        contact.linked_account_id !== recipient.account_id
      : !contact.email ||
        lower_email_address(contact.email) !== recipient.email_address)
  )
    throw Error("invitation contact changed or is unavailable");
}

/** Home-owned index pages bound owner work; projection membership is never authority. */
export async function listInvitationProjectsLocal(
  input: ListInvitationProjectsInput,
): Promise<ListInvitationProjectsResult> {
  const account_id = await home(input.account_id);
  const query = text(input.query ?? "");
  const { recipient, target } = normalizeSelection(input);
  if (recipient.kind === "account" && recipient.account_id === account_id)
    throw Error("cannot invite yourself");
  await checkContact(account_id, recipient);
  if (
    input.project_ids != null &&
    (!Array.isArray(input.project_ids) || input.project_ids.length > PAGE_SIZE)
  )
    throw Error("select at most 25 projects");
  const ids = [
    ...new Set(
      (input.project_ids ?? []).map((id) =>
        peopleInvitationUuid(id, "project_id"),
      ),
    ),
  ].sort();
  const binding = createHash("sha256")
    .update(
      JSON.stringify([
        "invitation-projects",
        account_id,
        recipient,
        query,
        ids,
        target ?? null,
      ]),
    )
    .digest("hex");
  const cursor = await decodePeopleCursor(input.cursor, binding, "1");
  if (cursor && cursor.after.length !== 1)
    throw Error("invalid invitation project cursor");
  const after = cursor
    ? peopleInvitationUuid(cursor.after[0], "project cursor")
    : null;
  const candidates = await withPeopleAccount(
    account_id,
    async (db) =>
      (
        await db.query(
          `SELECT project_id FROM account_project_index
      WHERE account_id=$1 AND ($2='' OR strpos(lower(COALESCE(title,'')),lower($2))>0)
      AND ($3::uuid IS NULL OR project_id>$3) AND ($4::uuid[] IS NULL OR project_id=ANY($4::uuid[]))
      ORDER BY project_id LIMIT $5`,
          [account_id, query, after, ids.length ? ids : null, PAGE_SIZE + 1],
        )
      ).rows as { project_id: string }[],
  );
  const projects: InvitationDiscoveryProject[] = [];
  let unavailable = false;
  for (const candidate of candidates.slice(0, PAGE_SIZE)) {
    try {
      const route = await resolveProjectBay(candidate.project_id);
      if (!route) throw Error("project owner unavailable");
      const opts: InspectInvitationProjectInput = {
        account_id,
        project_id: candidate.project_id,
        recipient,
        target,
        route,
      };
      const project =
        route.bay_id === getConfiguredBayId()
          ? await inspectInvitationProject(opts)
          : await createInterBayCollaboratorsClient({
              client: getInterBayFabricClient(),
              bay_id: route.bay_id,
            }).inspectInvitationProject(opts);
      if (project) projects.push(project);
    } catch {
      unavailable = true;
      projects.push({
        project_id: candidate.project_id,
        title: "Project unavailable",
        current_access: "unknown",
        content_access: "unknown",
        can_invite: false,
        can_notify: false,
        unavailable_reason:
          "Unable to verify current project permissions. Retry discovery.",
      });
    }
  }
  const last = candidates[Math.min(candidates.length, PAGE_SIZE) - 1];
  return {
    projects,
    ...(candidates.length > PAGE_SIZE && last
      ? {
          next_cursor: await encodePeopleCursor(
            binding,
            "1",
            [last.project_id],
            cursor?.expires,
          ),
        }
      : {}),
    ...(unavailable
      ? {
          notice:
            "Some project permissions could not be verified. No permission is inferred from cached membership.",
        }
      : {}),
  };
}

/** Trusted fabric endpoint. Resolve ownership again before reading the owner DB. */
export async function inspectInvitationProject(
  input: InspectInvitationProjectInput,
): Promise<InvitationDiscoveryProject | null> {
  await enabled();
  const account_id = peopleInvitationUuid(input.account_id, "account_id");
  const project_id = peopleInvitationUuid(input.project_id, "project_id");
  const { recipient, target } = normalizeSelection(input);
  const actual = await resolveProjectBay(project_id);
  if (
    !actual ||
    actual.bay_id !== getConfiguredBayId() ||
    actual.bay_id !== input.route?.bay_id ||
    actual.epoch !== input.route?.epoch
  )
    throw Error("stale invitation project-owner route");
  const row = await withProjectRehomeWriteFence({
    project_id,
    action: "inspect invitation permissions",
    fn: async (db) => {
      const current = await resolveProjectBay(project_id);
      if (current?.bay_id !== actual.bay_id || current?.epoch !== actual.epoch)
        throw Error("stale invitation project-owner route");
      const { rows } = await db.query(
        `SELECT title,users,manage_users_owner_only FROM projects
    WHERE project_id=$1 AND owning_bay_id=$2 AND deleted IS NOT TRUE`,
        [project_id, actual.bay_id],
      );
      const project = rows[0];
      if (
        project &&
        isProjectCollaboratorRole(project.users?.[account_id]?.group)
      ) {
        await ensureProjectCollabInviteEmailTokenSchema();
        const value =
          recipient.kind === "account"
            ? recipient.account_id
            : await hashInviteEmail(recipient.email_address);
        project.pendingOffers = (
          await db.query(
            `SELECT invite_role,read_policy FROM project_collab_invites
           WHERE project_id=$1 AND inviter_account_id=$2 AND status='pending'
           AND created + CASE WHEN invite_source IN ('email','course_email')
             THEN interval '14 days' ELSE interval '30 days' END > now()
           AND (scope IS NULL OR scope='project_collab')
           AND ${recipient.kind === "account" ? "invitee_account_id=$3::uuid" : "email_hash=$3"}
           ORDER BY created DESC LIMIT 2`,
            [project_id, account_id, value],
          )
        ).rows;
      }
      return project as
        | {
            title: string;
            users: Record<string, ProjectUserInfo>;
            manage_users_owner_only: boolean;
            pendingOffers: PendingOffer[];
          }
        | undefined;
    },
  });
  const actor = row?.users?.[account_id]?.group;
  if (!row || !isProjectCollaboratorRole(actor)) return null;
  const member =
    recipient.kind === "account"
      ? row.users?.[recipient.account_id]
      : undefined;
  const current_access =
    recipient.kind === "email"
      ? "unknown"
      : (normalizeProjectUserRole(member?.group) ?? "none");
  const canManage = actor === "owner" || !row.manage_users_owner_only;
  let content_access: InvitationDiscoveryProject["content_access"] =
    current_access === "unknown"
      ? "unknown"
      : current_access === "none"
        ? "denied"
        : "allowed";
  let unavailable_reason: string | undefined;
  if (target) {
    if (target.project_id !== project_id) {
      content_access = "denied";
      unavailable_reason =
        "This content belongs to another project. Invitations do not copy or move content.";
    } else {
      const resource = await getOwnedCollaborationResource(target, account_id, {
        owning_bay_id: actual.bay_id,
      });
      if (!resource) {
        content_access = "denied";
        unavailable_reason = "The selected content is no longer available.";
      } else if (current_access === "viewer") {
        // The collaboration catalog's reader contract currently requires a full collaborator.
        content_access = "denied";
      }
    }
  }
  if (row.pendingOffers.length > 1)
    unavailable_reason =
      "Multiple pending offers need review in Invites before creating another offer.";
  const pending =
    row.pendingOffers.length === 1 ? row.pendingOffers[0] : undefined;
  return {
    project_id,
    title: row.title || "Untitled project",
    current_access,
    ...(current_access === "viewer" && member?.read_policy
      ? { read_policy: member.read_policy }
      : {}),
    content_access,
    ...(pending
      ? {
          pending: {
            role: pending.invite_role ?? "collaborator",
            ...(pending.invite_role === "viewer" && pending.read_policy
              ? { read_policy: pending.read_policy }
              : {}),
          },
        }
      : {}),
    can_invite: canManage && !unavailable_reason,
    can_notify:
      recipient.kind === "account" &&
      content_access === "allowed" &&
      !unavailable_reason,
    ...(unavailable_reason ? { unavailable_reason } : {}),
  };
}
