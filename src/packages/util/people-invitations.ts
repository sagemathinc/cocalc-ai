/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationTarget } from "./collaborators";
import type { ProjectViewerReadPolicy } from "./project-access";
import { DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY } from "./project-access";
import {
  isValidUUID,
  is_valid_email_address,
  lower_email_address,
} from "./misc";

export const PEOPLE_INVITATION_LIMITS = {
  projects: 25,
  message: 2000,
  label: 160,
  draft_ttl_ms: 7 * 86400000,
  review_ttl_ms: 10 * 60000,
  pending_drafts: 100,
  retained_operations: 10000,
  sends_per_hour: 60,
  history_retention_ms: 90 * 86400000,
} as const;

/** Email specifications are never resolved by global exact-email lookup. */
export type PeopleInvitationRecipient =
  | { kind: "account"; account_id: string; person_id?: string }
  | { kind: "email"; email_address: string; person_id?: string };

export type PeopleInvitationTarget = CollaborationTarget & { label?: string };
export type PeopleInvitationProjectAction =
  | { project_id: string; action: "notify" }
  | {
      project_id: string;
      action: "offer_access";
      role: "collaborator" | "viewer";
      read_policy?: ProjectViewerReadPolicy;
    };

export interface PeopleInvitationPayload {
  recipient: PeopleInvitationRecipient;
  target?: PeopleInvitationTarget;
  projects: PeopleInvitationProjectAction[];
  message: string;
  channels: { notification: boolean; email: boolean };
}

export interface PeopleInvitationPreflight {
  project_id: string;
  action: PeopleInvitationProjectAction["action"];
  recipient_access: "sufficient" | "insufficient" | "unknown";
  warnings: string[];
}

export interface PeopleInvitationDraft {
  draft_id: string;
  revision: number;
  account_id: string;
  payload: PeopleInvitationPayload;
  preflight: PeopleInvitationPreflight[];
  created_at: number;
  expires_at: number;
}

export interface PreparePeopleInvitationInput {
  account_id?: string;
  /** Caller-generated UUID: a retry of initial preparation uses the same ID. */
  draft_id: string;
  /** Zero creates; subsequent revisions compare-and-swap the current revision. */
  expected_revision: number;
  payload: PeopleInvitationPayload;
}
export interface ReviewPeopleInvitationInput {
  account_id?: string;
  draft_id: string;
  revision: number;
}
export interface PeopleInvitationReview {
  review_id: string;
  draft: PeopleInvitationDraft;
  expires_at: number;
}
export interface SendPeopleInvitationInput extends ReviewPeopleInvitationInput {
  review_id: string;
  /** UUID, unique within the sender's namespace. */
  idempotency_key: string;
}

export type PeopleInvitationDeliveryStatus =
  | "queued"
  | "sent"
  | "failed"
  | "suppressed"
  | "unknown";
export interface PeopleInvitationDeliveryReceipt {
  channel: "notification" | "email";
  status: PeopleInvitationDeliveryStatus;
  receipt_id?: string;
  /** Safe public reason code, never provider errors, tokens or addresses. */
  reason?: string;
}
export interface PeopleInvitationActionReceipt {
  child_operation_id: string;
  project_id: string;
  action: PeopleInvitationProjectAction["action"];
  status:
    | "pending"
    | "created"
    | "reused"
    | "notified"
    | "review_required"
    | "failed"
    | "unknown";
  access_invite_id?: string;
  collaboration_invitation_id?: string;
  delivery: PeopleInvitationDeliveryReceipt[];
  reason?: string;
}
export interface PeopleInvitationOperation {
  operation_id: string;
  account_id: string;
  draft_id: string;
  revision: number;
  /** Immutable reviewed intent; no bearer invitation links are returned here. */
  payload: PeopleInvitationPayload;
  status: "admitted" | "running" | "complete" | "partial" | "unknown";
  outcomes: PeopleInvitationActionReceipt[];
  created_at: number;
  updated_at: number;
  source_version: number;
  /** No new project side effect may begin after this reviewed authorization expires. */
  authorization_expires_at: number;
}

/** Versioned permission-free intent. Recipient read/dismiss state is separate. */
export interface PeopleCollaborationInvitation {
  invitation_id: string;
  operation_id: string;
  sender_account_id: string;
  recipient: PeopleInvitationRecipient;
  project_id: string;
  target?: PeopleInvitationTarget;
  message: string;
  access_invite_ids: string[];
  state: "active" | "withdrawn";
  created_at: number;
  version: number;
}

export interface PeopleInvitationsApi {
  prepareInvitation(
    input: PreparePeopleInvitationInput,
  ): Promise<PeopleInvitationDraft>;
  reviewInvitation(
    input: ReviewPeopleInvitationInput,
  ): Promise<PeopleInvitationReview>;
  sendInvitation(
    input: SendPeopleInvitationInput,
  ): Promise<PeopleInvitationOperation>;
  getInvitationOperation(input: {
    account_id?: string;
    operation_id: string;
  }): Promise<PeopleInvitationOperation>;
}

export function peopleInvitationUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !isValidUUID(value))
    throw Error(`invalid ${name}`);
  return value.toLowerCase();
}

function record(value: unknown, keys: string[]): Record<string, any> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw Error("invalid invitation fields");
  }
  return value;
}

function bounded(value: unknown, max: number, name: string): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  ) {
    throw Error(`invalid ${name}`);
  }
  return value;
}

/** Canonical order is intentional: compare this form, never JSONB key order. */
export function normalizePeopleInvitationPayload(
  value: unknown,
): PeopleInvitationPayload {
  const p = record(value, [
    "recipient",
    "target",
    "projects",
    "message",
    "channels",
  ]);
  const r = record(p.recipient, [
    "kind",
    "account_id",
    "email_address",
    "person_id",
  ]);
  const person =
    r.person_id === undefined
      ? {}
      : { person_id: peopleInvitationUuid(r.person_id, "person_id") };
  let recipient: PeopleInvitationRecipient;
  if (r.kind === "account" && r.email_address === undefined) {
    recipient = {
      kind: "account",
      account_id: peopleInvitationUuid(r.account_id, "recipient account_id"),
      ...person,
    };
  } else if (r.kind === "email" && r.account_id === undefined) {
    const email_address = lower_email_address(
      bounded(r.email_address, 254, "email_address").trim(),
    );
    if (!is_valid_email_address(email_address))
      throw Error("invalid email_address");
    recipient = { kind: "email", email_address, ...person };
  } else throw Error("invalid invitation recipient");
  if (
    !Array.isArray(p.projects) ||
    !p.projects.length ||
    p.projects.length > PEOPLE_INVITATION_LIMITS.projects
  ) {
    throw Error("select between 1 and 25 projects");
  }
  const projects: PeopleInvitationProjectAction[] = p.projects.map((value) => {
    const a = record(value, ["project_id", "action", "role", "read_policy"]);
    const project_id = peopleInvitationUuid(a.project_id, "project_id");
    if (a.action === "notify") {
      if (
        a.role !== undefined ||
        a.read_policy !== undefined ||
        recipient.kind !== "account"
      )
        throw Error("invalid notification-only action");
      return { project_id, action: "notify" };
    }
    if (
      a.action !== "offer_access" ||
      !["collaborator", "viewer"].includes(a.role)
    )
      throw Error("invalid access offer");
    if (a.role === "collaborator") {
      if (a.read_policy !== undefined)
        throw Error("collaborator offers do not have a read policy");
      return { project_id, action: "offer_access", role: "collaborator" };
    }
    const policy = record(
      a.read_policy ?? DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
      ["rules"],
    );
    if (
      !Array.isArray(policy.rules) ||
      policy.rules.length > 100 ||
      !policy.rules.length
    )
      throw Error("invalid viewer policy");
    const rules = policy.rules.map((value) => {
      const rule = record(value, ["action", "path"]);
      if (rule.action !== "include" && rule.action !== "exclude")
        throw Error("invalid viewer rule");
      return {
        action: rule.action,
        path: bounded(rule.path, 1024, "viewer path"),
      };
    });
    return {
      project_id,
      action: "offer_access",
      role: "viewer",
      read_policy: { rules },
    };
  });
  if (new Set(projects.map((p) => p.project_id)).size !== projects.length)
    throw Error("duplicate project");
  let target: PeopleInvitationTarget | undefined;
  if (p.target !== undefined) {
    const t = record(p.target, ["project_id", "kind", "resource_id", "label"]);
    const project_id = peopleInvitationUuid(t.project_id, "target project_id");
    if (
      !["conversation", "agent", "artifact"].includes(t.kind) ||
      !projects.some((p) => p.project_id === project_id)
    )
      throw Error("invalid invitation target");
    const resource_id = bounded(t.resource_id, 512, "resource_id");
    if (!resource_id.trim()) throw Error("empty resource_id");
    target = {
      project_id,
      kind: t.kind,
      resource_id,
      ...(t.label === undefined
        ? {}
        : { label: bounded(t.label, PEOPLE_INVITATION_LIMITS.label, "label") }),
    };
  }
  const channels = record(p.channels, ["notification", "email"]);
  if (
    typeof channels.notification !== "boolean" ||
    typeof channels.email !== "boolean"
  )
    throw Error("invalid channels");
  return {
    recipient,
    ...(target ? { target } : {}),
    projects,
    message: bounded(p.message, PEOPLE_INVITATION_LIMITS.message, "message"),
    channels: { notification: channels.notification, email: channels.email },
  };
}
