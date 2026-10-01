/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type {
  InvitationProject,
  InvitationProjectChoice,
  InvitationRecipient,
} from "./invitation-api";

export const INVITATION_PROJECT_LIMIT = 25;

export function recipientKey(recipient: InvitationRecipient): string {
  switch (recipient.kind) {
    case "account":
      return `account:${recipient.account_id}`;
    case "email":
      return `email:${recipient.email_address}`;
  }
}

export function defaultProjectChoice(
  project: InvitationProject,
): InvitationProjectChoice | undefined {
  const { project_id, current_access, can_notify, can_invite, pending } =
    project;
  if (
    current_access === "owner" ||
    current_access === "collaborator" ||
    current_access === "viewer"
  ) {
    // A viewer upgrade is never a default, even when the intended content is denied.
    return can_notify ? { project_id, action: "notify" } : undefined;
  }
  if (!can_invite) return;
  return {
    project_id,
    action: "offer_access",
    role: pending?.role ?? "collaborator",
    ...(pending?.read_policy ? { read_policy: pending.read_policy } : {}),
  };
}

export function projectAccessLabel(project: InvitationProject): string {
  switch (project.current_access) {
    case "owner":
      return "Already a collaborator (owner)";
    case "collaborator":
      return "Already a collaborator";
    case "viewer":
      return "Viewer";
    case "unknown":
      return "Current access unknown for this email/contact";
    case "none":
      return "No current access";
  }
}

export function invitationChoiceLabel(choice: InvitationProjectChoice): string {
  return choice.action === "notify"
    ? "Notification only; no access change"
    : choice.role === "viewer"
      ? "Invite as viewer (read-only)"
      : "Invite as collaborator (project read/write and runtimes)";
}
