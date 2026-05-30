/*
Add, remove and invite collaborators on projects.
*/

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { db } from "@cocalc/database";
import { listProjectedMyCollaboratorsForAccount } from "@cocalc/database/postgres/account-collaborator-index";
import {
  createNotificationEventGraph,
  resolveNotificationTargetHomeBays,
} from "@cocalc/database/postgres/notifications-core";
import getPool from "@cocalc/database/pool";
import { callback2 } from "@cocalc/util/async-utils";
import {
  assertLocalProjectCollaborator,
  getLocalProjectAccessStatus,
} from "@cocalc/server/conat/project-local-access";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import type {
  AddCollaborator,
  MyCollaboratorRow,
  ProjectAccessLandingInfo,
  ProjectAccessRequestAction,
  ProjectAccessRequestBlockRow,
  ProjectAccessRequestRow,
  ProjectAccessRequestSource,
  ProjectAccessRequestStatus,
  ProjectCollabInviteAction,
  ProjectCollabInviteBlockRow,
  ProjectCollabInviteDirection,
  ProjectCollabInviteRow,
  ProjectCollabInviteStatus,
  ProjectCollaboratorRow,
} from "@cocalc/conat/hub/api/projects";
import { add_collaborators_to_projects } from "./collab";
import {
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
import {
  ensureAccountSecurityStateReady,
  isAccountBannedCached,
} from "@cocalc/server/accounts/security-state";
import {
  DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
  isProjectUserRole,
  normalizeProjectUserRole,
  type ProjectUserRole,
  type ProjectViewerReadPolicy,
} from "@cocalc/util/project-access";
import { RESEND_INVITE_INTERVAL_DAYS } from "@cocalc/util/consts/invites";
import { syncProjectUsersOnHost } from "@cocalc/server/project-host/control";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getClusterAccountById,
  getClusterAccountsByIds,
} from "@cocalc/server/inter-bay/accounts";
import {
  deleteProjectedInboundCollabInvite,
  listProjectedInboundCollabInvites,
  respondProjectedInboundCollabInvite,
  syncProjectedInboundCollabInvite,
} from "@cocalc/server/projects/collab-invite-inbox";
import { assertAccountTrustedForProductAccess } from "@cocalc/server/accounts/trusted-product-access";
import { getBayPublicOrigin } from "@cocalc/server/bay-public-origin";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import {
  assertCourseStudentInviteLimit,
  assertProjectCollaboratorInviteLimit,
} from "@cocalc/server/membership/project-limits";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import { getSecretSettingsKey } from "@cocalc/database/settings/secret-settings";
import {
  decryptSecretSettingValue,
  encryptSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";
import { upsertProjectCollabInviteDirectory } from "@cocalc/server/projects/collab-invite-directory";
import { appendProjectLogRowBestEffort } from "@cocalc/server/projects/project-log";

const logger = getLogger("project:collaborators");
const COLLAB_GROUPS = ["owner", "collaborator"] as const;
const PROJECT_ACCESS_GROUP_SET = new Set<string>([...COLLAB_GROUPS, "viewer"]);
const COLLAB_INVITE_EXPIRES_DAYS = 30;
const COLLAB_INVITE_EXPIRES_INTERVAL = `${COLLAB_INVITE_EXPIRES_DAYS} days`;
const EMAIL_ONLY_INVITE_TTL_DAYS = 14;
const EMAIL_INVITE_EXPIRES_INTERVAL = `${EMAIL_ONLY_INVITE_TTL_DAYS} days`;
const ACCESS_REQUEST_RETRY_COOLDOWN_MINUTES = 30;
const ACCESS_REQUEST_DAILY_ACCOUNT_LIMIT = 25;
const EMAIL_INVITE_TOKEN_AAD = "project_collab_invites.token";
const EMAIL_INVITE_EMAIL_AAD = "project_collab_invites.email";
const EMAIL_INVITE_HASH_AAD = "project_collab_invites.email-token:v2";
const EMAIL_INVITE_SOURCE = "email";
const EMAIL_INVITE_SCOPE = "project_collab";
const COURSE_EMAIL_INVITE_SCOPE = "course_student";
const DEFAULT_INVITE_ROLE = "collaborator" as const;
const INVITE_STATUS_SET = new Set<string>([
  "pending",
  "accepted",
  "declined",
  "blocked",
  "expired",
  "canceled",
]);
const ACCESS_REQUEST_STATUS_SET = new Set<string>([
  "pending",
  "approved",
  "denied",
  "blocked",
  "canceled",
]);
const ACCESS_REQUEST_ACTION_SET = new Set<string>([
  "approve",
  "deny",
  "block",
  "cancel",
]);
const ACCESS_REQUEST_SOURCE_SET = new Set<string>([
  "project-url",
  "viewer-read-only",
  "rail-menu",
  "api",
]);
let projectCollabInviteEmailTokenSchemaReady: Promise<void> | undefined;
let projectAccessRequestSchemaReady: Promise<void> | undefined;

type CollaboratorReadMode = "off" | "prefer" | "only";
type InviteEmailBlockedReason =
  | "email_not_configured"
  | "tier_disallows_email"
  | "cooldown"
  | "send_disabled_by_request";

export interface InviteEmailDeliveryStatus {
  email_sent: boolean;
  email_available: boolean;
  manual_delivery_required: boolean;
  email_blocked_reason?: InviteEmailBlockedReason | null;
}

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

function normalizeInviteRole(
  value?: unknown,
): Exclude<ProjectUserRole, "owner"> {
  const role = normalizeProjectUserRole(value);
  if (role == null) {
    return DEFAULT_INVITE_ROLE;
  }
  if (role === "owner") {
    throw new Error("invite_role must be collaborator or viewer");
  }
  return role;
}

function normalizeInviteReadPolicy({
  invite_role,
  read_policy,
}: {
  invite_role: Exclude<ProjectUserRole, "owner">;
  read_policy?: ProjectViewerReadPolicy | null;
}): ProjectViewerReadPolicy | null {
  if (invite_role !== "viewer") {
    return null;
  }
  return read_policy ?? DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY;
}

function emailUnavailableFromSendMessage(message: string | undefined): boolean {
  const value = `${message ?? ""}`.toLowerCase();
  return (
    value.includes("no actual message sent") ||
    value.includes("no email sent") ||
    value.includes("emails is disabled") ||
    value.includes("email is disabled")
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

function normalizeAccessRequestStatus(
  value?: ProjectAccessRequestStatus,
): ProjectAccessRequestStatus | undefined {
  if (value == null) return undefined;
  const status = `${value}`.trim().toLowerCase();
  if (ACCESS_REQUEST_STATUS_SET.has(status)) {
    return status as ProjectAccessRequestStatus;
  }
  throw new Error(
    `invalid status '${value}' (expected pending, approved, denied, blocked, or canceled)`,
  );
}

function normalizeAccessRequestAction(
  value: ProjectAccessRequestAction,
): ProjectAccessRequestAction {
  const action = `${value}`.trim().toLowerCase();
  if (ACCESS_REQUEST_ACTION_SET.has(action)) {
    return action as ProjectAccessRequestAction;
  }
  throw new Error(
    `invalid action '${value}' (expected approve, deny, block, or cancel)`,
  );
}

function normalizeAccessRequestRole(
  value: unknown,
): Exclude<ProjectUserRole, "owner"> {
  const role = normalizeProjectUserRole(value);
  if (role === "viewer" || role === "collaborator") {
    return role;
  }
  throw new Error("requested_role must be viewer or collaborator");
}

function normalizeAccessRequestSource(
  value?: string,
): ProjectAccessRequestSource | string {
  const source = `${value ?? "api"}`.trim().toLowerCase();
  if (!source) return "api";
  if (source.length > 48) {
    throw new Error("source must be at most 48 characters");
  }
  return ACCESS_REQUEST_SOURCE_SET.has(source)
    ? (source as ProjectAccessRequestSource)
    : source;
}

function ensureUuid(value: string, label: string): void {
  if (!is_valid_uuid_string(value)) {
    throw new Error(`${label} must be a valid uuid`);
  }
}

async function ensureProjectCollabInviteEmailTokenSchema(): Promise<void> {
  if (projectCollabInviteEmailTokenSchemaReady) {
    return await projectCollabInviteEmailTokenSchemaReady;
  }
  projectCollabInviteEmailTokenSchemaReady =
    ensureProjectCollabInviteEmailTokenSchemaUncached();
  return await projectCollabInviteEmailTokenSchemaReady;
}

async function ensureProjectCollabInviteEmailTokenSchemaUncached(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    ALTER TABLE project_collab_invites
      ADD COLUMN IF NOT EXISTS invite_source VARCHAR(24),
      ADD COLUMN IF NOT EXISTS accepted_account_id UUID,
      ADD COLUMN IF NOT EXISTS email_hash TEXT,
      ADD COLUMN IF NOT EXISTS email_ciphertext TEXT,
      ADD COLUMN IF NOT EXISTS token_hash TEXT,
      ADD COLUMN IF NOT EXISTS token_ciphertext TEXT,
      ADD COLUMN IF NOT EXISTS token_hint VARCHAR(16),
      ADD COLUMN IF NOT EXISTS last_sent TIMESTAMP,
      ADD COLUMN IF NOT EXISTS resend_count INTEGER,
      ADD COLUMN IF NOT EXISTS scope VARCHAR(48),
      ADD COLUMN IF NOT EXISTS context JSONB,
      ADD COLUMN IF NOT EXISTS invite_role VARCHAR(24),
      ADD COLUMN IF NOT EXISTS read_policy JSONB
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS project_collab_invites_email_pending_idx
       ON project_collab_invites (project_id, inviter_account_id, email_hash, status)
       WHERE invite_source IN ('email', 'course_email')`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS project_collab_invites_email_expire_idx
       ON project_collab_invites (status, created)
       WHERE invite_source IN ('email', 'course_email')`,
  );
}

async function ensureProjectAccessRequestSchema(): Promise<void> {
  if (projectAccessRequestSchemaReady) {
    return await projectAccessRequestSchemaReady;
  }
  projectAccessRequestSchemaReady = ensureProjectAccessRequestSchemaUncached();
  return await projectAccessRequestSchemaReady;
}

async function ensureProjectAccessRequestSchemaUncached(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_access_requests (
      request_id UUID PRIMARY KEY,
      project_id UUID NOT NULL,
      requester_account_id UUID NOT NULL,
      requested_role VARCHAR(24) NOT NULL,
      read_policy JSONB,
      message TEXT,
      status VARCHAR(24) NOT NULL,
      source VARCHAR(48) NOT NULL,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      updated TIMESTAMP NOT NULL DEFAULT NOW(),
      decided TIMESTAMP,
      decided_by_account_id UUID,
      decision_message TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_access_request_blocks (
      project_id UUID NOT NULL,
      blocker_account_id UUID NOT NULL,
      blocked_account_id UUID NOT NULL,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      updated TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, blocked_account_id)
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS project_access_requests_pending_unique_idx
       ON project_access_requests (project_id, requester_account_id)
       WHERE status='pending'`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS project_access_requests_project_status_idx
       ON project_access_requests (project_id, status, updated DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS project_access_requests_requester_idx
       ON project_access_requests (requester_account_id, updated DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS project_access_request_blocks_blocked_idx
       ON project_access_request_blocks (blocked_account_id, updated DESC)`,
  );
}

async function inviteSecretKey(): Promise<Buffer> {
  return await getSecretSettingsKey();
}

async function hmacInviteValue(aad: string, value: string): Promise<string> {
  const digest = createHmac("sha256", await inviteSecretKey())
    .update(aad)
    .update("\0")
    .update(value)
    .digest("base64url");
  return `${aad}:${digest}`;
}

export async function hashProjectCollabInviteToken(
  token: string,
): Promise<string> {
  const digest = createHash("sha256")
    .update(EMAIL_INVITE_HASH_AAD)
    .update("\0")
    .update(token)
    .digest("base64url");
  return `${EMAIL_INVITE_HASH_AAD}:${digest}`;
}

async function registerEmailInviteDirectory({
  invite_id,
  project_id,
  token_hash,
  scope,
  status = "pending",
}: {
  invite_id: string;
  project_id: string;
  token_hash: string;
  scope?: string | null;
  status?: ProjectCollabInviteStatus;
}): Promise<void> {
  await upsertProjectCollabInviteDirectory({
    invite_id,
    project_id,
    token_hash,
    owning_bay_id: getConfiguredBayId(),
    invite_source: EMAIL_INVITE_SOURCE,
    scope: scope ?? EMAIL_INVITE_SCOPE,
    status,
  });
}

async function ensureBayIndependentInviteTokenHash({
  invite_id,
  current_token_hash,
  token,
}: {
  invite_id: string;
  current_token_hash?: string | null;
  token: string;
}): Promise<string> {
  const token_hash = await hashProjectCollabInviteToken(token);
  if (current_token_hash !== token_hash) {
    await getPool().query(
      `UPDATE project_collab_invites
          SET token_hash=$2, updated=NOW()
        WHERE invite_id=$1`,
      [invite_id, token_hash],
    );
  }
  return token_hash;
}

async function hashInviteEmail(email: string): Promise<string> {
  return await hmacInviteValue(EMAIL_INVITE_EMAIL_AAD, email);
}

async function encryptInviteValue(aad: string, value: string): Promise<string> {
  return encryptSecretSettingValue(aad, value, await inviteSecretKey());
}

async function decryptInviteValue(aad: string, value: string): Promise<string> {
  return decryptSecretSettingValue(aad, value, await inviteSecretKey());
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function generateInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

async function inviteUrl({ token }: { token: string }): Promise<string> {
  const base = (
    await getBayPublicOrigin(getConfiguredClusterSeedBayId())
  )?.replace(/\/+$/, "");
  if (!base) {
    throw new Error("unable to determine public site URL for invite link");
  }
  return `${base}/invites/${encodeURIComponent(token)}`;
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
  await ensureProjectCollabInviteEmailTokenSchema();
  const { rows } = await pool.query<{
    invite_id: string;
    invitee_account_id: string | null;
  }>(
    `UPDATE project_collab_invites
       SET status='expired', responded=COALESCE(responded, NOW()), updated=NOW()
     WHERE status='pending'
       AND created < NOW() - CASE
         WHEN invite_source IN ('email', 'course_email')
         THEN INTERVAL '${EMAIL_INVITE_EXPIRES_INTERVAL}'
         ELSE INTERVAL '${COLLAB_INVITE_EXPIRES_INTERVAL}'
       END
     RETURNING invite_id, invitee_account_id`,
  );
  await Promise.all(
    rows.map(async (row) => {
      await deleteProjectedInboundCollabInvite({
        invite_id: row.invite_id,
        invitee_account_id: row.invitee_account_id,
      });
    }),
  );
}

async function fetchInviteById(
  invite_id: string,
  includeEmail: boolean,
): Promise<ProjectCollabInviteRow | undefined> {
  await ensureProjectCollabInviteEmailTokenSchema();
  const pool = getPool();
  const { rows } = await pool.query<ProjectCollabInviteRow>(
    `SELECT
       i.invite_id,
       i.project_id,
       p.title AS project_title,
       p.description AS project_description,
       i.inviter_account_id,
       NULLIF(BTRIM(CONCAT_WS(' ', inviter.first_name, inviter.last_name)), '') AS inviter_name,
       inviter.first_name AS inviter_first_name,
       inviter.last_name AS inviter_last_name,
       CASE WHEN $2::boolean THEN inviter.email_address ELSE NULL END AS inviter_email_address,
       i.invitee_account_id,
       NULLIF(BTRIM(CONCAT_WS(' ', invitee.first_name, invitee.last_name)), '') AS invitee_name,
       invitee.first_name AS invitee_first_name,
       invitee.last_name AS invitee_last_name,
       CASE WHEN $2::boolean THEN invitee.email_address ELSE NULL END AS invitee_email_address,
       i.invite_source,
       i.accepted_account_id,
       CASE
         WHEN $2::boolean THEN i.email_ciphertext
         ELSE NULL
       END AS email_ciphertext,
       i.token_hint,
       i.last_sent,
       i.resend_count,
       i.scope,
       i.context,
       COALESCE(i.invite_role, 'collaborator') AS invite_role,
       i.read_policy,
       i.status,
       i.message,
       i.responder_action,
       i.created,
       i.updated,
       i.responded,
       i.created + CASE
         WHEN i.invite_source IN ('email', 'course_email')
         THEN INTERVAL '${EMAIL_INVITE_EXPIRES_INTERVAL}'
         ELSE INTERVAL '${COLLAB_INVITE_EXPIRES_INTERVAL}'
       END AS expires
     FROM project_collab_invites i
     LEFT JOIN projects p ON p.project_id=i.project_id
     LEFT JOIN accounts inviter ON inviter.account_id=i.inviter_account_id
     LEFT JOIN accounts invitee ON invitee.account_id=i.invitee_account_id
     WHERE i.invite_id=$1
     LIMIT 1`,
    [invite_id, includeEmail],
  );
  const [row] = rows;
  if (!row) {
    return undefined;
  }
  return (await hydrateInviteRows([row], includeEmail))[0];
}

function fillNameParts(target: any, entry?: any): void {
  if (!entry) return;
  if (!target.first_name && entry.first_name)
    target.first_name = entry.first_name;
  if (!target.last_name && entry.last_name) target.last_name = entry.last_name;
  if (!target.name && entry.name) target.name = entry.name;
  if (!target.email_address && entry.email_address) {
    target.email_address = entry.email_address;
  }
}

async function hydrateInviteRows(
  rows: ProjectCollabInviteRow[],
  includeEmail: boolean,
): Promise<ProjectCollabInviteRow[]> {
  if (rows.length === 0) {
    return rows;
  }
  const accountIds = new Set<string>();
  for (const row of rows) {
    if (row.inviter_account_id) accountIds.add(row.inviter_account_id);
    if (row.invitee_account_id) accountIds.add(row.invitee_account_id);
  }
  const entries = await getClusterAccountsByIds([...accountIds]);
  const byId = new Map(entries.map((entry) => [entry.account_id, entry]));
  return await Promise.all(
    rows.map(async (row) => {
      const inviter = {
        name: row.inviter_name,
        first_name: row.inviter_first_name,
        last_name: row.inviter_last_name,
        email_address: row.inviter_email_address,
      };
      fillNameParts(inviter, byId.get(row.inviter_account_id));
      const invitee = {
        name: row.invitee_name,
        first_name: row.invitee_first_name,
        last_name: row.invitee_last_name,
        email_address: row.invitee_email_address,
      };
      fillNameParts(
        invitee,
        row.invitee_account_id ? byId.get(row.invitee_account_id) : undefined,
      );
      let target_email: string | null = null;
      const emailCiphertext = (row as any).email_ciphertext;
      if (emailCiphertext) {
        try {
          target_email = await decryptInviteValue(
            EMAIL_INVITE_EMAIL_AAD,
            emailCiphertext,
          );
        } catch {
          target_email = null;
        }
      }
      const hydrated = {
        ...row,
        inviter_name: inviter.name,
        inviter_first_name: inviter.first_name,
        inviter_last_name: inviter.last_name,
        inviter_email_address: includeEmail
          ? (inviter.email_address ?? null)
          : (row.inviter_email_address ?? null),
        invitee_name: invitee.name,
        invitee_first_name: invitee.first_name,
        invitee_last_name: invitee.last_name,
        invitee_email_address: includeEmail
          ? (invitee.email_address ?? null)
          : (row.invitee_email_address ?? null),
        target_email,
      };
      delete (hydrated as any).email_ciphertext;
      return hydrated;
    }),
  );
}

function fillLastActive(target: any, entry?: any): void {
  if (!entry?.last_active || target.last_active != null) {
    return;
  }
  target.last_active = new Date(entry.last_active);
}

function maybeHideEmail(entry: any, includeEmail: boolean): any {
  if (!entry || includeEmail) {
    return entry;
  }
  return { ...entry, email_address: undefined };
}

async function hydrateCollaboratorRows(
  rows: ProjectCollaboratorRow[],
  includeEmail: boolean,
): Promise<ProjectCollaboratorRow[]> {
  if (rows.length === 0) {
    return rows;
  }
  const entries = await getClusterAccountsByIds(
    rows.map((row) => row.account_id),
  );
  const byId = new Map(entries.map((entry) => [entry.account_id, entry]));
  return rows.map((row) => {
    const entry = byId.get(row.account_id);
    const hydrated = {
      ...row,
      name: row.name,
      first_name: row.first_name,
      last_name: row.last_name,
      email_address: row.email_address,
      last_active: row.last_active,
    };
    fillNameParts(hydrated, maybeHideEmail(entry, includeEmail));
    fillLastActive(hydrated, entry);
    if (!includeEmail) {
      hydrated.email_address = row.email_address ?? null;
    }
    return hydrated;
  });
}

function collaboratorRowsFromProjectUsers(
  users?: Record<string, any> | null,
): ProjectCollaboratorRow[] {
  return Object.entries(users ?? {})
    .map(([account_id, info]) => ({
      account_id,
      group: `${info?.group ?? ""}` as ProjectCollaboratorRow["group"],
      read_policy: info?.read_policy ?? null,
    }))
    .filter((row) => PROJECT_ACCESS_GROUP_SET.has(row.group))
    .sort((a, b) => {
      const groupOrder =
        (a.group === "owner" ? 0 : 1) - (b.group === "owner" ? 0 : 1);
      return groupOrder || a.account_id.localeCompare(b.account_id);
    });
}

async function hydrateMyCollaboratorRows(
  rows: MyCollaboratorRow[],
  includeEmail: boolean,
): Promise<MyCollaboratorRow[]> {
  if (rows.length === 0) {
    return rows;
  }
  const entries = await getClusterAccountsByIds(
    rows.map((row) => row.account_id),
  );
  const byId = new Map(entries.map((entry) => [entry.account_id, entry]));
  return rows.map((row) => {
    const entry = byId.get(row.account_id);
    const hydrated = {
      ...row,
      name: row.name,
      first_name: row.first_name,
      last_name: row.last_name,
      email_address: row.email_address,
      last_active: row.last_active,
    };
    fillNameParts(hydrated, maybeHideEmail(entry, includeEmail));
    fillLastActive(hydrated, entry);
    if (!includeEmail) {
      hydrated.email_address = row.email_address ?? null;
    }
    return hydrated;
  });
}

async function hydrateInviteBlockRows(
  rows: ProjectCollabInviteBlockRow[],
  includeEmail: boolean,
): Promise<ProjectCollabInviteBlockRow[]> {
  if (rows.length === 0) {
    return rows;
  }
  const accountIds = new Set<string>();
  for (const row of rows) {
    if (row.blocker_account_id) accountIds.add(row.blocker_account_id);
    if (row.blocked_account_id) accountIds.add(row.blocked_account_id);
  }
  const entries = await getClusterAccountsByIds([...accountIds]);
  const byId = new Map(entries.map((entry) => [entry.account_id, entry]));
  return rows.map((row) => {
    const blocker = {
      name: row.blocker_name,
    };
    fillNameParts(blocker, byId.get(row.blocker_account_id));
    const blocked = {
      name: row.blocked_name,
      first_name: row.blocked_first_name,
      last_name: row.blocked_last_name,
      email_address: row.blocked_email_address,
    };
    fillNameParts(
      blocked,
      maybeHideEmail(byId.get(row.blocked_account_id), includeEmail),
    );
    return {
      ...row,
      blocker_name: blocker.name,
      blocked_name: blocked.name,
      blocked_first_name: blocked.first_name,
      blocked_last_name: blocked.last_name,
      blocked_email_address: includeEmail
        ? (blocked.email_address ?? null)
        : (row.blocked_email_address ?? null),
    };
  });
}

async function addUserToProjectForAcceptedInvite({
  account_id,
  project_id,
  invite_role,
  read_policy,
}: {
  account_id: string;
  project_id: string;
  invite_role?: string | null;
  read_policy?: ProjectViewerReadPolicy | null;
}): Promise<void> {
  const role = normalizeInviteRole(invite_role);
  const policy = normalizeInviteReadPolicy({ invite_role: role, read_policy });
  const database = db();
  await callback2(database.add_user_to_project.bind(database), {
    project_id,
    account_id,
    group: role,
  });
  const rolePatch =
    role === "viewer"
      ? { group: "viewer", read_policy: policy }
      : { group: "collaborator" };
  await getPool().query(
    `
      UPDATE projects
         SET users = jsonb_set(
           COALESCE(users, '{}'::jsonb),
           ARRAY[$2::text],
           CASE
             WHEN $3::text = 'collaborator' THEN
               (COALESCE(users -> $2::text, '{}'::jsonb) - 'read_policy') || $4::jsonb
             ELSE
               COALESCE(users -> $2::text, '{}'::jsonb) || $4::jsonb
           END,
           true
         )
       WHERE project_id=$1
         AND COALESCE(users -> $2::text ->> 'group', '') <> 'owner'
    `,
    [project_id, account_id, role, JSON.stringify(rolePatch)],
  );
  await appendProjectOutboxEventForProject({
    event_type: "project.membership_changed",
    project_id,
  });
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
  if (opts.account_id === account_id) {
    if (
      (await getLocalProjectAccessStatus({
        account_id,
        project_id: opts.project_id,
      })) !== "local-project-user"
    ) {
      throw new Error("user is not a member of this project");
    }
  } else {
    await assertLocalProjectCollaborator({
      account_id,
      project_id: opts.project_id,
    });
    await assertCanManageProjectCollaborators({
      account_id,
      action: "remove collaborators",
      project_id: opts.project_id,
    });
  }
  const database = db();
  await callback2(
    database.remove_collaborator_from_project.bind(database),
    opts,
  );
  await cancelPendingInvitesFromRemovedCollaborator({
    inviter_account_id: opts.account_id,
    project_id: opts.project_id,
  });
  await publishProjectAccountFeedEventsBestEffort({
    project_id: opts.project_id,
  });
}

export async function setProjectUserRole({
  account_id,
  opts,
}: {
  account_id: string;
  opts: {
    project_id: string;
    target_account_id: string;
    role: Exclude<ProjectUserRole, "owner">;
    read_policy?: ProjectViewerReadPolicy | null;
  };
}): Promise<void> {
  ensureUuid(account_id, "account_id");
  ensureUuid(opts.project_id, "project_id");
  ensureUuid(opts.target_account_id, "target_account_id");
  if (opts.role !== "collaborator" && opts.role !== "viewer") {
    throw new Error("role must be collaborator or viewer");
  }
  await assertLocalProjectCollaborator({
    account_id,
    project_id: opts.project_id,
  });
  await assertCanManageProjectCollaborators({
    account_id,
    action: "change collaborator roles",
    project_id: opts.project_id,
  });
  const rolePatch =
    opts.role === "viewer"
      ? {
          group: "viewer",
          read_policy:
            opts.read_policy ?? DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
        }
      : { group: "collaborator" };
  const { rows } = await getPool().query<{ group: string | null }>(
    `
      UPDATE projects
         SET users = jsonb_set(
           users,
           ARRAY[$2::text],
           CASE
             WHEN $3::text = 'collaborator' THEN
               (COALESCE(users -> $2::text, '{}'::jsonb) - 'read_policy') || $4::jsonb
             ELSE
               COALESCE(users -> $2::text, '{}'::jsonb) || $4::jsonb
           END,
           false
         )
       WHERE project_id=$1
         AND users ? $2::text
         AND users -> $2::text ->> 'group' <> 'owner'
       RETURNING users -> $2::text ->> 'group' AS "group"
    `,
    [
      opts.project_id,
      opts.target_account_id,
      opts.role,
      JSON.stringify(rolePatch),
    ],
  );
  if (!isProjectUserRole(rows[0]?.group)) {
    throw new Error("target account is not a non-owner project user");
  }
  await appendProjectOutboxEventForProject({
    db: getPool(),
    event_type: "project.membership_changed",
    project_id: opts.project_id,
    default_bay_id: getConfiguredBayId(),
  });
  await syncProjectUsersOnHost({ project_id: opts.project_id });
  await publishProjectAccountFeedEventsBestEffort({
    project_id: opts.project_id,
  });
}

async function cancelPendingInvitesFromRemovedCollaborator({
  inviter_account_id,
  project_id,
}: {
  inviter_account_id: string;
  project_id: string;
}): Promise<void> {
  ensureUuid(inviter_account_id, "inviter_account_id");
  ensureUuid(project_id, "project_id");
  await ensureProjectCollabInviteEmailTokenSchema();
  const { rows } = await getPool().query<{
    invite_id: string;
    invitee_account_id: string | null;
  }>(
    `UPDATE project_collab_invites
        SET status='canceled',
            responder_action='revoke',
            responded=NOW(),
            updated=NOW()
      WHERE project_id=$1
        AND inviter_account_id=$2
        AND status='pending'
      RETURNING invite_id, invitee_account_id`,
    [project_id, inviter_account_id],
  );
  await Promise.all(
    rows.map(async (row) => {
      await deleteProjectedInboundCollabInvite({
        invite_id: row.invite_id,
        invitee_account_id: row.invitee_account_id,
      });
    }),
  );
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
  await assertAccountTrustedForProductAccess(
    account_id,
    "accept collaboration invites",
  );
  let projects: undefined | string | string[] = opts.project_id;
  let accounts: undefined | string | string[] = opts.account_id;

  if (projects == null) {
    throw new Error("project_id must be specified");
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
  );
  for (const project_id of projects as string[]) {
    if (project_id) {
      await publishProjectAccountFeedEventsBestEffort({ project_id });
    }
  }
  return { project_id: projects };
}

export async function createCollabInvite({
  account_id,
  project_id,
  invitee_account_id,
  message,
  direct,
  invite_role,
  read_policy,
}: {
  account_id?: string;
  project_id: string;
  invitee_account_id: string;
  message?: string;
  direct?: boolean;
  invite_role?: Exclude<ProjectUserRole, "owner">;
  read_policy?: ProjectViewerReadPolicy | null;
}): Promise<{
  created: boolean;
  invite: ProjectCollabInviteRow;
}> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  await assertAccountTrustedForProductAccess(
    account_id,
    "invite collaborators",
  );
  ensureUuid(project_id, "project_id");
  ensureUuid(invitee_account_id, "invitee_account_id");
  if (invitee_account_id === account_id) {
    throw new Error("cannot invite yourself");
  }
  await assertLocalProjectCollaborator({ account_id, project_id });
  await assertCanManageProjectCollaborators({
    account_id,
    action: "invite collaborators",
    project_id,
  });
  await ensureProjectCollabInviteEmailTokenSchema();
  const role = normalizeInviteRole(invite_role);
  const policy = normalizeInviteReadPolicy({ invite_role: role, read_policy });

  const pool = getPool();
  const includeEmail = await isAdmin(account_id);
  await expirePendingCollabInvites(pool);
  const normalizedMessage = await normalizeInviteMessageForAccount({
    account_id,
    message,
  });

  const inviteeAccount = await getClusterAccountById(invitee_account_id);
  if (!inviteeAccount?.account_id) {
    throw new Error(`account '${invitee_account_id}' does not exist`);
  }

  const { rows: collabRows } = await pool.query<{
    existing_group: string | null;
  }>(
    `SELECT users -> $2::text ->> 'group' AS existing_group
       FROM projects
      WHERE project_id=$1
      LIMIT 1`,
    [project_id, invitee_account_id],
  );
  const existingGroup = collabRows[0]?.existing_group;
  if (existingGroup === "owner" || existingGroup === "collaborator") {
    throw new Error("target account already has full project access");
  }
  if (existingGroup === "viewer" && role === "viewer") {
    throw new Error("target account is already a viewer");
  }

  if (role === "collaborator") {
    await assertProjectCollaboratorInviteLimit({ project_id });
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
    await addUserToProjectForAcceptedInvite({
      project_id,
      account_id: invitee_account_id,
      invite_role: role,
      read_policy: policy,
    });
    await syncProjectUsersOnHostBestEffort(
      project_id,
      "create-collab-invite-direct",
    );
    await publishProjectAccountFeedEventsBestEffort({ project_id });
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
        invite_role: role,
        read_policy: policy,
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
       AND COALESCE(invite_role, 'collaborator')=$4
       AND status='pending'
     ORDER BY created DESC
     LIMIT 1`,
    [project_id, account_id, invitee_account_id, role],
  );
  const existingPending = pendingRows[0]?.invite_id;
  if (existingPending) {
    const invite = await fetchInviteById(existingPending, includeEmail);
    if (!invite) {
      throw new Error("failed to load existing pending invite");
    }
    await syncProjectedInboundCollabInvite({
      source_bay_id: getConfiguredBayId(),
      invite,
      invitee_home_bay_id: inviteeAccount.home_bay_id,
    });
    return {
      created: false,
      invite,
    };
  }

  const invite_id = uuid();
  await pool.query(
    `INSERT INTO project_collab_invites
      (invite_id, project_id, inviter_account_id, invitee_account_id,
       invite_role, read_policy, status, message, created, updated)
     VALUES
      ($1, $2, $3, $4, $5, $6::jsonb, 'pending', $7, NOW(), NOW())`,
    [
      invite_id,
      project_id,
      account_id,
      invitee_account_id,
      role,
      JSON.stringify(policy),
      normalizedMessage,
    ],
  );
  const invite = await fetchInviteById(invite_id, includeEmail);
  if (!invite) {
    throw new Error("failed to load created invite");
  }
  await syncProjectedInboundCollabInvite({
    source_bay_id: getConfiguredBayId(),
    invite,
    invitee_home_bay_id: inviteeAccount.home_bay_id,
  });
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
  projectWide,
}: {
  account_id?: string;
  project_id?: string;
  direction?: ProjectCollabInviteDirection;
  status?: ProjectCollabInviteStatus;
  limit?: number;
  projectWide?: boolean;
}): Promise<ProjectCollabInviteRow[]> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  if (projectWide && !project_id) {
    throw new Error("project_id is required for project-wide invites");
  }
  const includeEmail = await isAdmin(account_id);
  const normalizedDirection = normalizeInviteDirection(direction);
  const normalizedStatus = normalizeInviteStatus(status);
  const maxRows = Math.max(1, Math.min(1000, Number(limit ?? 200) || 200));
  const pool = getPool();
  await ensureProjectCollabInviteEmailTokenSchema();
  await expirePendingCollabInvites(pool);

  const params: any[] = [includeEmail];
  const where: string[] = [];
  if (project_id) {
    ensureUuid(project_id, "project_id");
    if (projectWide) {
      await assertLocalProjectCollaborator({ account_id, project_id });
    }
    params.push(project_id);
    where.push(`i.project_id=$${params.length}`);
  }

  params.push(account_id);
  const accountParam = `$${params.length}`;
  const otherAccountExpr = `CASE WHEN i.inviter_account_id=${accountParam}::uuid THEN i.invitee_account_id ELSE i.inviter_account_id END`;
  if (projectWide) {
    // Project-wide mode is for the project pending-invites panel. The project
    // collaborator check above replaces per-account invite ownership filters.
  } else if (normalizedDirection === "inbound") {
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
      NULLIF(BTRIM(CONCAT_WS(' ', inviter.first_name, inviter.last_name)), '') AS inviter_name,
      inviter.first_name AS inviter_first_name,
      inviter.last_name AS inviter_last_name,
      CASE WHEN $1::boolean THEN inviter.email_address ELSE NULL END AS inviter_email_address,
      i.invitee_account_id,
      NULLIF(BTRIM(CONCAT_WS(' ', invitee.first_name, invitee.last_name)), '') AS invitee_name,
      invitee.first_name AS invitee_first_name,
      invitee.last_name AS invitee_last_name,
      CASE WHEN $1::boolean THEN invitee.email_address ELSE NULL END AS invitee_email_address,
      i.invite_source,
      i.accepted_account_id,
      CASE
        WHEN $1::boolean OR i.inviter_account_id=${accountParam}::uuid THEN i.email_ciphertext
        ELSE NULL
      END AS email_ciphertext,
      i.token_hint,
      i.last_sent,
      i.resend_count,
      i.scope,
      i.context,
      COALESCE(i.invite_role, 'collaborator') AS invite_role,
      i.read_policy,
      i.status,
      i.message,
      i.responder_action,
      i.created,
      i.updated,
      i.responded,
      i.created + CASE
        WHEN i.invite_source IN ('email', 'course_email')
        THEN INTERVAL '${EMAIL_INVITE_EXPIRES_INTERVAL}'
        ELSE INTERVAL '${COLLAB_INVITE_EXPIRES_INTERVAL}'
      END AS expires,
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
  const projectedRows =
    projectWide || normalizedDirection === "outbound"
      ? []
      : await listProjectedInboundCollabInvites({
          account_id,
          project_id,
          status: normalizedStatus,
          limit: maxRows,
        });
  return await hydrateInviteRows(
    [...rows, ...projectedRows]
      .sort(
        (a, b) =>
          new Date(`${b.created ?? 0}`).valueOf() -
          new Date(`${a.created ?? 0}`).valueOf(),
      )
      .slice(0, maxRows),
    includeEmail,
  );
}

async function getCanonicalCollabInvite(
  pool: ReturnType<typeof getPool>,
  invite_id: string,
): Promise<
  | {
      invite_id: string;
      project_id: string;
      inviter_account_id: string;
      invitee_account_id: string | null;
      accepted_account_id?: string | null;
      invite_source?: string | null;
      scope?: string | null;
      invite_role?: string | null;
      read_policy?: ProjectViewerReadPolicy | null;
      token_hash?: string | null;
      token_ciphertext?: string | null;
      status: string;
    }
  | undefined
> {
  await ensureProjectCollabInviteEmailTokenSchema();
  const { rows } = await pool.query<{
    invite_id: string;
    project_id: string;
    inviter_account_id: string;
    invitee_account_id: string | null;
    accepted_account_id?: string | null;
    invite_source?: string | null;
    scope?: string | null;
    invite_role?: string | null;
    read_policy?: ProjectViewerReadPolicy | null;
    token_hash?: string | null;
    token_ciphertext?: string | null;
    status: string;
  }>(
    `SELECT invite_id, project_id, inviter_account_id, invitee_account_id,
            accepted_account_id, invite_source, scope,
            COALESCE(invite_role, 'collaborator') AS invite_role,
            read_policy,
            token_hash, token_ciphertext, status
     FROM project_collab_invites
     WHERE invite_id=$1
     LIMIT 1`,
    [invite_id],
  );
  return rows[0];
}

async function getPendingEmailCollabInviteForToken({
  invite_id,
  project_id,
  token,
}: {
  invite_id: string;
  project_id?: string;
  token: string;
}): Promise<{
  invite_id: string;
  project_id: string;
  inviter_account_id: string;
  token_hash: string;
  scope?: string | null;
  invite_role?: string | null;
  read_policy?: ProjectViewerReadPolicy | null;
}> {
  ensureUuid(invite_id, "invite_id");
  if (project_id) {
    ensureUuid(project_id, "project_id");
  }
  await ensureProjectCollabInviteEmailTokenSchema();
  const pool = getPool();
  await expirePendingCollabInvites(pool);
  const { rows } = await pool.query<{
    invite_id: string;
    project_id: string;
    inviter_account_id: string;
    status: string;
    token_hash: string | null;
    scope?: string | null;
    invite_role?: string | null;
    read_policy?: ProjectViewerReadPolicy | null;
  }>(
    `SELECT invite_id, project_id, inviter_account_id, status, token_hash,
            scope, COALESCE(invite_role, 'collaborator') AS invite_role,
            read_policy
       FROM project_collab_invites
      WHERE invite_id=$1
        AND invite_source IN ('email', 'course_email')
      LIMIT 1`,
    [invite_id],
  );
  const invite = rows[0];
  if (!invite || !invite.token_hash) {
    throw new Error(`invite '${invite_id}' not found`);
  }
  const token_hash = invite.token_hash;
  if (project_id && invite.project_id !== project_id) {
    throw new Error("project invite link is invalid for this project");
  }
  if (
    !timingSafeStringEqual(
      token_hash,
      await hashProjectCollabInviteToken(token),
    )
  ) {
    throw new Error("invalid invite token");
  }
  if (invite.status !== "pending") {
    throw new Error(`invite is not pending (status=${invite.status})`);
  }
  return { ...invite, token_hash };
}

async function assertInviteSenderCanStillGrantAccess({
  pool,
  invite,
}: {
  pool: ReturnType<typeof getPool>;
  invite: {
    project_id: string;
    inviter_account_id: string;
  };
}): Promise<void> {
  ensureUuid(invite.project_id, "project_id");
  ensureUuid(invite.inviter_account_id, "inviter_account_id");
  await ensureAccountSecurityStateReady();
  if (isAccountBannedCached(invite.inviter_account_id)) {
    throw new Error("invite sender is banned");
  }
  const { rows } = await pool.query<{
    inviter_group: string | null;
    manage_users_owner_only: boolean | null;
  }>(
    `SELECT users -> $2::text ->> 'group' AS inviter_group,
            COALESCE(manage_users_owner_only, false) AS manage_users_owner_only
       FROM projects
      WHERE project_id=$1
      LIMIT 1`,
    [invite.project_id, invite.inviter_account_id],
  );
  const row = rows[0];
  if (row?.inviter_group !== "owner" && row?.inviter_group !== "collaborator") {
    throw new Error("invite sender no longer has access to this project");
  }
  if (row.manage_users_owner_only && row.inviter_group !== "owner") {
    throw new Error(
      "invite sender is no longer allowed to grant access to this project",
    );
  }
}

export async function respondCollabInviteCanonical({
  account_id,
  invite_id,
  action,
  includeEmail,
  trustedProductAccessChecked,
}: {
  account_id: string;
  invite_id: string;
  action: ProjectCollabInviteAction;
  includeEmail: boolean;
  trustedProductAccessChecked?: boolean;
}): Promise<ProjectCollabInviteRow> {
  const normalizedAction = normalizeInviteAction(action);
  const pool = getPool();
  await expirePendingCollabInvites(pool);
  const invite = await getCanonicalCollabInvite(pool, invite_id);
  if (!invite) {
    throw new Error(`invite '${invite_id}' not found`);
  }
  if (invite.status !== "pending") {
    throw new Error(`invite is not pending (status=${invite.status})`);
  }
  const admin = includeEmail;
  const emailTokenInvite =
    invite.invite_source === "email" || invite.invite_source === "course_email";

  if (normalizedAction === "revoke") {
    if (invite.inviter_account_id !== account_id && !admin) {
      await assertLocalProjectCollaborator({
        account_id,
        project_id: invite.project_id,
      });
    }
    await pool.query(
      `UPDATE project_collab_invites
        SET status='canceled', responder_action=$2, responded=NOW(), updated=NOW()
        WHERE invite_id=$1`,
      [invite_id, normalizedAction],
    );
    await deleteProjectedInboundCollabInvite({
      invite_id,
      invitee_account_id: invite.invitee_account_id,
    });
    const updated = await fetchInviteById(invite_id, includeEmail);
    if (!updated) {
      throw new Error("failed to load invite response");
    }
    return updated;
  }

  if (emailTokenInvite) {
    throw new Error(
      "email invite links must be accepted using the invite token",
    );
  }

  if (invite.invitee_account_id !== account_id) {
    throw new Error("only invite recipient can respond");
  }

  let nextStatus: ProjectCollabInviteStatus = "declined";
  if (normalizedAction === "accept") {
    await assertInviteSenderCanStillGrantAccess({ pool, invite });
    if (!trustedProductAccessChecked) {
      await assertAccountTrustedForProductAccess(
        account_id,
        "accept collaboration invites",
      );
    }
    const role = normalizeInviteRole(invite.invite_role);
    const { rows: collabRows } = await pool.query<{
      existing_group: string | null;
    }>(
      `SELECT users -> $2::text ->> 'group' AS existing_group
         FROM projects
        WHERE project_id=$1
        LIMIT 1`,
      [invite.project_id, account_id],
    );
    const existingGroup = collabRows[0]?.existing_group;
    const needsGrant =
      existingGroup !== "owner" &&
      existingGroup !== "collaborator" &&
      !(existingGroup === "viewer" && role === "viewer");
    const needsUpgrade = existingGroup === "viewer" && role === "collaborator";
    if (needsGrant || needsUpgrade) {
      await addUserToProjectForAcceptedInvite({
        project_id: invite.project_id,
        account_id,
        invite_role: invite.invite_role,
        read_policy: invite.read_policy,
      });
      await syncProjectUsersOnHostBestEffort(
        invite.project_id,
        "respond-collab-invite-accept",
      );
    } else {
      await appendProjectOutboxEventForProject({
        event_type: "project.membership_changed",
        project_id: invite.project_id,
      });
    }
    await publishProjectAccountFeedEventsBestEffort({
      project_id: invite.project_id,
    });
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
  await deleteProjectedInboundCollabInvite({
    invite_id,
    invitee_account_id: invite.invitee_account_id,
  });
  const updated = await fetchInviteById(invite_id, includeEmail);
  if (!updated) {
    throw new Error("failed to load invite response");
  }
  return updated;
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
  ensureUuid(invite_id, "invite_id");
  const pool = getPool();
  await expirePendingCollabInvites(pool);
  const local = await getCanonicalCollabInvite(pool, invite_id);
  if (local) {
    return await respondCollabInviteCanonical({
      account_id,
      invite_id,
      action: normalizedAction,
      includeEmail,
    });
  }
  if (normalizedAction === "accept") {
    await assertAccountTrustedForProductAccess(
      account_id,
      "accept collaboration invites",
    );
  }
  const projected = await respondProjectedInboundCollabInvite({
    account_id,
    invite_id,
    action: normalizedAction,
    includeEmail,
  });
  if (!projected) {
    throw new Error(`invite '${invite_id}' not found`);
  }
  return projected;
}

function projectAccessRequestRow(row: any): ProjectAccessRequestRow {
  return {
    request_id: row.request_id,
    project_id: row.project_id,
    project_title: row.project_title ?? null,
    requester_account_id: row.requester_account_id,
    requester_name: row.requester_name ?? null,
    requester_first_name: row.requester_first_name ?? null,
    requester_last_name: row.requester_last_name ?? null,
    requester_profile: row.requester_profile ?? null,
    requested_role: normalizeAccessRequestRole(row.requested_role),
    read_policy: row.read_policy ?? null,
    message: row.message ?? null,
    status: normalizeAccessRequestStatus(row.status)!,
    source: row.source ?? "api",
    created: row.created,
    updated: row.updated,
    decided: row.decided ?? null,
    decided_by_account_id: row.decided_by_account_id ?? null,
    decision_message: row.decision_message ?? null,
  };
}

async function fetchProjectAccessRequestById({
  project_id,
  request_id,
}: {
  project_id: string;
  request_id: string;
}): Promise<ProjectAccessRequestRow | null> {
  const { rows } = await getPool().query(
    `SELECT
       r.*,
       p.title AS project_title,
       NULLIF(BTRIM(CONCAT_WS(' ', a.first_name, a.last_name)), '') AS requester_name,
       a.first_name AS requester_first_name,
       a.last_name AS requester_last_name,
       a.profile AS requester_profile
     FROM project_access_requests r
     LEFT JOIN projects p ON p.project_id=r.project_id
     LEFT JOIN accounts a ON a.account_id=r.requester_account_id
     WHERE r.project_id=$1 AND r.request_id=$2
     LIMIT 1`,
    [project_id, request_id],
  );
  return rows[0] ? projectAccessRequestRow(rows[0]) : null;
}

function projectAccessRequestDisplayName(
  request: Pick<
    ProjectAccessRequestRow,
    | "requester_account_id"
    | "requester_name"
    | "requester_first_name"
    | "requester_last_name"
  >,
): string {
  return (
    request.requester_name ||
    `${request.requester_first_name ?? ""} ${
      request.requester_last_name ?? ""
    }`.trim() ||
    request.requester_account_id
  );
}

function projectTitleForNotification(
  project_id: string,
  title?: string | null,
): string {
  return `${title ?? ""}`.trim() || `project ${project_id}`;
}

function projectAccessRequestApproverAccountIds({
  requester_account_id,
  users,
  manage_users_owner_only,
}: {
  requester_account_id: string;
  users?: Record<string, { group?: string }> | null;
  manage_users_owner_only?: boolean | null;
}): string[] {
  const approvers: string[] = [];
  for (const [account_id, info] of Object.entries(users ?? {})) {
    if (account_id === requester_account_id) continue;
    const group = info?.group;
    if (
      group === "owner" ||
      (group === "collaborator" && manage_users_owner_only !== true)
    ) {
      approvers.push(account_id);
    }
  }
  return approvers;
}

async function notifyProjectAccessRequestCreatedBestEffort({
  actor_account_id,
  project_id,
  project_title,
  request,
  target_account_ids,
}: {
  actor_account_id: string;
  project_id: string;
  project_title?: string | null;
  request: ProjectAccessRequestRow;
  target_account_ids: string[];
}): Promise<void> {
  if (target_account_ids.length === 0) return;
  try {
    const source_bay_id = getConfiguredBayId();
    const target_home_bays = await resolveNotificationTargetHomeBays({
      account_ids: target_account_ids,
      default_bay_id: source_bay_id,
    });
    const requester = projectAccessRequestDisplayName(request);
    const title = `${requester} requested ${request.requested_role} access`;
    const projectTitle = projectTitleForNotification(project_id, project_title);
    const body = request.message
      ? `${requester} requested ${request.requested_role} access to **${projectTitle}**.\n\n> ${request.message}`
      : `${requester} requested ${request.requested_role} access to **${projectTitle}**.`;
    await createNotificationEventGraph({
      kind: "account_notice",
      source_bay_id,
      source_project_id: project_id,
      actor_account_id,
      origin_kind: "project",
      payload_json: {
        severity: "info",
        title,
        body_markdown: body,
        origin_label: "Project access",
        action_link: `/projects/${project_id}/settings`,
        action_label: "Review request",
        notice_type: "project_access_request",
        request_id: request.request_id,
        requested_role: request.requested_role,
      },
      targets: target_account_ids.map((target_account_id) => ({
        target_account_id,
        target_home_bay_id: target_home_bays[target_account_id],
        dedupe_key: [
          "project-access-request",
          project_id,
          request.requester_account_id,
          target_account_id,
        ].join(":"),
        summary_json: {
          title,
          body_markdown: body,
          severity: "info",
          origin_label: "Project access",
          action_link: `/projects/${project_id}/settings`,
          action_label: "Review request",
          notice_type: "project_access_request",
          request_id: request.request_id,
          requested_role: request.requested_role,
        },
      })),
    });
  } catch (err) {
    logger.warn("failed to notify project access request approvers", {
      err,
      project_id,
      request_id: request.request_id,
    });
  }
}

async function notifyProjectAccessRequestDecisionBestEffort({
  actor_account_id,
  project_id,
  request,
}: {
  actor_account_id: string;
  project_id: string;
  request: ProjectAccessRequestRow;
}): Promise<void> {
  if (!["approved", "denied", "blocked"].includes(request.status)) return;
  try {
    const source_bay_id = getConfiguredBayId();
    const target_home_bays = await resolveNotificationTargetHomeBays({
      account_ids: [request.requester_account_id],
      default_bay_id: source_bay_id,
    });
    const projectTitle = projectTitleForNotification(
      project_id,
      request.project_title,
    );
    const statusText =
      request.status === "approved"
        ? "approved"
        : request.status === "blocked"
          ? "blocked"
          : "denied";
    const title = `Project access request ${statusText}`;
    const body =
      request.status === "approved"
        ? `Your request for ${request.requested_role} access to **${projectTitle}** was approved.`
        : request.status === "blocked"
          ? `Your request for access to **${projectTitle}** was denied, and this project is not accepting further access requests from your account.`
          : `Your request for access to **${projectTitle}** was denied.`;
    const action_link =
      request.status === "approved" ? `/projects/${project_id}` : undefined;
    const action_label = request.status === "approved" ? "Open project" : "";
    await createNotificationEventGraph({
      kind: "account_notice",
      source_bay_id,
      source_project_id: project_id,
      actor_account_id,
      origin_kind: "project",
      payload_json: {
        severity: request.status === "approved" ? "info" : "warning",
        title,
        body_markdown: body,
        origin_label: "Project access",
        action_link,
        action_label,
        notice_type: "project_access_request_decision",
        request_id: request.request_id,
        requested_role: request.requested_role,
        status: request.status,
      },
      targets: [
        {
          target_account_id: request.requester_account_id,
          target_home_bay_id: target_home_bays[request.requester_account_id],
          dedupe_key: [
            "project-access-request-decision",
            project_id,
            request.request_id,
            request.requester_account_id,
          ].join(":"),
          summary_json: {
            title,
            body_markdown: body,
            severity: request.status === "approved" ? "info" : "warning",
            origin_label: "Project access",
            action_link,
            action_label,
            notice_type: "project_access_request_decision",
            request_id: request.request_id,
            requested_role: request.requested_role,
            status: request.status,
          },
        },
      ],
    });
  } catch (err) {
    logger.warn("failed to notify project access request decision", {
      err,
      project_id,
      request_id: request.request_id,
    });
  }
}

async function assertProjectAccessRequestCreationLimits({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<void> {
  const { rows } = await getPool().query<{
    retry_count: number;
    daily_count: number;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE project_id=$2::uuid
           AND status IN ('denied', 'canceled')
           AND updated > NOW() - ($3::TEXT || ' minutes')::INTERVAL
       )::INT AS retry_count,
       COUNT(*) FILTER (
         WHERE created > NOW() - INTERVAL '1 day'
       )::INT AS daily_count
     FROM project_access_requests
     WHERE requester_account_id=$1::uuid`,
    [account_id, project_id, ACCESS_REQUEST_RETRY_COOLDOWN_MINUTES],
  );
  const retryCount = Number(rows[0]?.retry_count ?? 0);
  if (retryCount > 0) {
    throw new Error(
      `project access request cooldown active; try again in ${ACCESS_REQUEST_RETRY_COOLDOWN_MINUTES} minutes`,
    );
  }
  const dailyCount = Number(rows[0]?.daily_count ?? 0);
  if (dailyCount >= ACCESS_REQUEST_DAILY_ACCOUNT_LIMIT) {
    throw new Error(
      `daily project access request limit reached (${dailyCount}/${ACCESS_REQUEST_DAILY_ACCOUNT_LIMIT}); try again later`,
    );
  }
}

async function appendProjectAccessRequestLogBestEffort({
  account_id,
  project_id,
  request,
  event,
  role,
}: {
  account_id: string | null;
  project_id: string;
  request: ProjectAccessRequestRow;
  event:
    | "project_access_request_created"
    | "project_access_request_approved"
    | "project_access_request_denied"
    | "project_access_request_blocked"
    | "project_access_request_canceled";
  role?: ProjectUserRole;
}): Promise<void> {
  const suffix =
    event === "project_access_request_created" ? "created" : request.status;
  await appendProjectLogRowBestEffort({
    project_id,
    context: "project-access-request",
    row: {
      id: `project-access-request:${request.request_id}:${suffix}`,
      project_id,
      account_id,
      time: new Date(),
      event: {
        event,
        request_id: request.request_id,
        requester_account_id: request.requester_account_id,
        requested_role: request.requested_role,
        ...(role ? { role } : {}),
      },
    },
  });
}

export async function getProjectAccessLandingInfo({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}): Promise<ProjectAccessLandingInfo> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  ensureUuid(project_id, "project_id");
  await ensureProjectCollabInviteEmailTokenSchema();
  await ensureProjectAccessRequestSchema();
  const admin = await isAdmin(account_id);
  const { rows } = await getPool().query<{
    title: string | null;
    users: Record<string, any> | null;
    owner_account_id: string | null;
    owner_name: string | null;
    owner_first_name: string | null;
    owner_last_name: string | null;
    owner_profile: Record<string, any> | null;
    invite_id: string | null;
    invite_role: string | null;
    invite_read_policy: ProjectViewerReadPolicy | null;
    request_id: string | null;
    requested_role: string | null;
    blocked: boolean | null;
  }>(
    `SELECT
       p.title,
       p.users,
       owner_id.account_id AS owner_account_id,
       NULLIF(BTRIM(CONCAT_WS(' ', owner.first_name, owner.last_name)), '') AS owner_name,
       owner.first_name AS owner_first_name,
       owner.last_name AS owner_last_name,
       owner.profile AS owner_profile,
       invite.invite_id,
       COALESCE(invite.invite_role, 'collaborator') AS invite_role,
       invite.read_policy AS invite_read_policy,
       request.request_id,
       request.requested_role,
       EXISTS(
         SELECT 1
           FROM project_access_request_blocks block
          WHERE block.project_id=p.project_id
            AND block.blocked_account_id=$2::uuid
       ) AS blocked
     FROM projects p
     LEFT JOIN LATERAL (
       SELECT member.key::uuid AS account_id
         FROM jsonb_each(COALESCE(p.users, '{}'::jsonb)) AS member(key, info)
        WHERE member.key ~* '^[0-9a-f-]{36}$'
          AND member.info ->> 'group' = 'owner'
        ORDER BY member.key
        LIMIT 1
     ) owner_id ON true
     LEFT JOIN accounts owner ON owner.account_id=owner_id.account_id
     LEFT JOIN LATERAL (
       SELECT i.invite_id, i.invite_role, i.read_policy
         FROM project_collab_invites i
        WHERE i.project_id=p.project_id
          AND i.invitee_account_id=$2::uuid
          AND i.status='pending'
          AND COALESCE(i.invite_source, 'account')='account'
        ORDER BY i.updated DESC
        LIMIT 1
     ) invite ON true
     LEFT JOIN LATERAL (
       SELECT r.request_id, r.requested_role
         FROM project_access_requests r
        WHERE r.project_id=p.project_id
          AND r.requester_account_id=$2::uuid
          AND r.status='pending'
        ORDER BY r.updated DESC
        LIMIT 1
     ) request ON true
     WHERE p.project_id=$1`,
    [project_id, account_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`project '${project_id}' not found`);
  }
  const group = row.users?.[account_id]?.group;
  const relationship: ProjectAccessLandingInfo["relationship"] = admin
    ? "admin"
    : group === "owner" || group === "collaborator" || group === "viewer"
      ? group
      : "none";
  const inviteRole = row.invite_id
    ? normalizeInviteRole(row.invite_role)
    : undefined;
  const requestRole = row.request_id
    ? normalizeAccessRequestRole(row.requested_role)
    : undefined;
  return {
    project_id,
    title: row.title ?? null,
    owner: row.owner_account_id
      ? {
          account_id: row.owner_account_id,
          name: row.owner_name ?? null,
          first_name: row.owner_first_name ?? null,
          last_name: row.owner_last_name ?? null,
          profile: row.owner_profile ?? null,
        }
      : undefined,
    relationship,
    pending_invite:
      row.invite_id && inviteRole
        ? {
            invite_id: row.invite_id,
            invite_role: inviteRole,
            read_policy: row.invite_read_policy ?? null,
          }
        : null,
    pending_request:
      row.request_id && requestRole
        ? {
            request_id: row.request_id,
            requested_role: requestRole,
            status: "pending",
          }
        : null,
    blocked: !!row.blocked,
  };
}

export async function requestProjectAccess({
  account_id,
  project_id,
  requested_role,
  read_policy,
  message,
  source,
}: {
  account_id?: string;
  project_id: string;
  requested_role: Exclude<ProjectUserRole, "owner">;
  read_policy?: ProjectViewerReadPolicy | null;
  message?: string;
  source?: ProjectAccessRequestSource | string;
}): Promise<ProjectAccessRequestRow> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  ensureUuid(project_id, "project_id");
  await assertAccountTrustedForProductAccess(
    account_id,
    "request project access",
  );
  await ensureProjectAccessRequestSchema();
  const role = normalizeAccessRequestRole(requested_role);
  const policy = normalizeInviteReadPolicy({
    invite_role: role,
    read_policy,
  });
  const normalizedSource = normalizeAccessRequestSource(source);
  const normalizedMessage = await normalizeAccessRequestMessageForAccount({
    account_id,
    message,
  });
  const pool = getPool();
  const { rows: projectRows } = await pool.query<{
    title: string | null;
    users: Record<string, { group?: string }> | null;
    manage_users_owner_only: boolean | null;
    current_group: string | null;
    blocked: boolean;
  }>(
    `SELECT
       p.title,
       p.users,
       p.manage_users_owner_only,
       p.users -> $2::text ->> 'group' AS current_group,
       EXISTS(
         SELECT 1
           FROM project_access_request_blocks block
          WHERE block.project_id=p.project_id
            AND block.blocked_account_id=$2::uuid
       ) AS blocked
     FROM projects p
     WHERE p.project_id=$1
     LIMIT 1`,
    [project_id, account_id],
  );
  const project = projectRows[0];
  if (!project) {
    throw new Error(`project '${project_id}' not found`);
  }
  if (project.blocked) {
    throw new Error(
      "project is not accepting access requests from this account",
    );
  }
  if (
    project.current_group === "owner" ||
    project.current_group === "collaborator"
  ) {
    throw new Error("account already has full project access");
  }
  if (project.current_group === "viewer" && role !== "collaborator") {
    throw new Error("viewers can only request collaborator access");
  }
  const { rows: pendingRows } = await pool.query<{ request_id: string }>(
    `SELECT request_id
       FROM project_access_requests
      WHERE project_id=$1
        AND requester_account_id=$2
        AND status='pending'
      ORDER BY updated DESC
      LIMIT 1`,
    [project_id, account_id],
  );
  const existingPendingRequestId = pendingRows[0]?.request_id;
  if (!existingPendingRequestId) {
    await assertProjectAccessRequestCreationLimits({
      account_id,
      project_id,
    });
  }
  const requestId = uuid();
  const { rows } = await pool.query<{ request_id: string }>(
    `INSERT INTO project_access_requests
       (request_id, project_id, requester_account_id, requested_role, read_policy,
        message, status, source, created, updated)
     VALUES
       ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW(), NOW())
     ON CONFLICT (project_id, requester_account_id)
       WHERE status='pending'
     DO UPDATE SET
       requested_role=EXCLUDED.requested_role,
       read_policy=EXCLUDED.read_policy,
       message=EXCLUDED.message,
       source=EXCLUDED.source,
       updated=NOW()
     RETURNING request_id`,
    [
      requestId,
      project_id,
      account_id,
      role,
      policy ? JSON.stringify(policy) : null,
      normalizedMessage,
      normalizedSource,
    ],
  );
  const updated = await fetchProjectAccessRequestById({
    project_id,
    request_id: rows[0]?.request_id ?? requestId,
  });
  if (!updated) {
    throw new Error("failed to load project access request");
  }
  if (!existingPendingRequestId) {
    await appendProjectAccessRequestLogBestEffort({
      account_id,
      project_id,
      request: updated,
      event: "project_access_request_created",
    });
    await notifyProjectAccessRequestCreatedBestEffort({
      actor_account_id: account_id,
      project_id,
      project_title: project.title,
      request: updated,
      target_account_ids: projectAccessRequestApproverAccountIds({
        requester_account_id: account_id,
        users: project.users,
        manage_users_owner_only: project.manage_users_owner_only,
      }),
    });
  }
  return updated;
}

export async function listProjectAccessRequests({
  account_id,
  project_id,
  status,
  limit,
}: {
  account_id?: string;
  project_id: string;
  status?: ProjectAccessRequestStatus;
  limit?: number;
}): Promise<ProjectAccessRequestRow[]> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  ensureUuid(project_id, "project_id");
  await ensureProjectAccessRequestSchema();
  await assertCanManageProjectCollaborators({
    account_id,
    action: "review project access requests",
    project_id,
  });
  const normalizedStatus = normalizeAccessRequestStatus(status);
  const maxRows = Math.max(1, Math.min(1000, Number(limit ?? 200) || 200));
  const { rows } = await getPool().query(
    `SELECT
       r.*,
       p.title AS project_title,
       NULLIF(BTRIM(CONCAT_WS(' ', a.first_name, a.last_name)), '') AS requester_name,
       a.first_name AS requester_first_name,
       a.last_name AS requester_last_name,
       a.profile AS requester_profile
     FROM project_access_requests r
     LEFT JOIN projects p ON p.project_id=r.project_id
     LEFT JOIN accounts a ON a.account_id=r.requester_account_id
     WHERE r.project_id=$1
       AND ($2::text IS NULL OR r.status=$2)
     ORDER BY r.updated DESC, r.request_id
     LIMIT $3`,
    [project_id, normalizedStatus ?? null, maxRows],
  );
  return rows.map(projectAccessRequestRow);
}

export async function respondProjectAccessRequest({
  account_id,
  project_id,
  request_id,
  action,
  role,
  read_policy,
  message,
}: {
  account_id?: string;
  project_id: string;
  request_id: string;
  action: ProjectAccessRequestAction;
  role?: Exclude<ProjectUserRole, "owner">;
  read_policy?: ProjectViewerReadPolicy | null;
  message?: string;
}): Promise<ProjectAccessRequestRow> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  ensureUuid(project_id, "project_id");
  ensureUuid(request_id, "request_id");
  await ensureProjectAccessRequestSchema();
  const normalizedAction = normalizeAccessRequestAction(action);
  const pool = getPool();
  const { rows } = await pool.query<ProjectAccessRequestRow>(
    `SELECT * FROM project_access_requests
      WHERE project_id=$1 AND request_id=$2
      LIMIT 1`,
    [project_id, request_id],
  );
  const request = rows[0];
  if (!request) {
    throw new Error(`project access request '${request_id}' not found`);
  }
  if (request.status !== "pending") {
    throw new Error(
      `project access request is not pending (status=${request.status})`,
    );
  }
  if (
    normalizedAction !== "cancel" ||
    request.requester_account_id !== account_id
  ) {
    await assertCanManageProjectCollaborators({
      account_id,
      action: `${normalizedAction} project access requests`,
      project_id,
    });
  }
  const decisionMessage = await normalizeAccessRequestMessageForAccount({
    account_id,
    message,
  });
  let nextStatus: ProjectAccessRequestStatus;
  let approvedRole: Exclude<ProjectUserRole, "owner"> | undefined;
  if (normalizedAction === "approve") {
    approvedRole = role
      ? normalizeAccessRequestRole(role)
      : normalizeAccessRequestRole(request.requested_role);
    if (
      request.requested_role === "viewer" &&
      approvedRole === "collaborator"
    ) {
      throw new Error(
        "cannot silently upgrade a viewer request to collaborator",
      );
    }
    await addUserToProjectForAcceptedInvite({
      project_id,
      account_id: request.requester_account_id,
      invite_role: approvedRole,
      read_policy:
        approvedRole === "viewer" ? (read_policy ?? request.read_policy) : null,
    });
    await syncProjectUsersOnHostBestEffort(
      project_id,
      "respond-project-access-request-approve",
    );
    await publishProjectAccountFeedEventsBestEffort({ project_id });
    nextStatus = "approved";
  } else if (normalizedAction === "block") {
    await pool.query(
      `INSERT INTO project_access_request_blocks
        (project_id, blocker_account_id, blocked_account_id, created, updated)
       VALUES
        ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (project_id, blocked_account_id)
       DO UPDATE SET blocker_account_id=EXCLUDED.blocker_account_id,
                     updated=EXCLUDED.updated`,
      [project_id, account_id, request.requester_account_id],
    );
    nextStatus = "blocked";
  } else if (normalizedAction === "cancel") {
    if (
      request.requester_account_id !== account_id &&
      !(await isAdmin(account_id))
    ) {
      throw new Error(
        "only requester or an admin can cancel an access request",
      );
    }
    nextStatus = "canceled";
  } else {
    nextStatus = "denied";
  }
  await pool.query(
    `UPDATE project_access_requests
        SET status=$3,
            decided=NOW(),
            decided_by_account_id=$4,
            decision_message=$5,
            updated=NOW()
      WHERE project_id=$1 AND request_id=$2`,
    [project_id, request_id, nextStatus, account_id, decisionMessage],
  );
  const updated = await fetchProjectAccessRequestById({
    project_id,
    request_id,
  });
  if (!updated) {
    throw new Error("failed to load project access request response");
  }
  await appendProjectAccessRequestLogBestEffort({
    account_id,
    project_id,
    request: updated,
    event:
      nextStatus === "approved"
        ? "project_access_request_approved"
        : nextStatus === "blocked"
          ? "project_access_request_blocked"
          : nextStatus === "canceled"
            ? "project_access_request_canceled"
            : "project_access_request_denied",
    role: approvedRole,
  });
  await notifyProjectAccessRequestDecisionBestEffort({
    actor_account_id: account_id,
    project_id,
    request: updated,
  });
  return updated;
}

export async function listProjectAccessRequestBlocks({
  account_id,
  project_id,
  limit,
}: {
  account_id?: string;
  project_id: string;
  limit?: number;
}): Promise<ProjectAccessRequestBlockRow[]> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  ensureUuid(project_id, "project_id");
  await ensureProjectAccessRequestSchema();
  await assertCanManageProjectCollaborators({
    account_id,
    action: "review blocked project access requesters",
    project_id,
  });
  const maxRows = Math.max(1, Math.min(1000, Number(limit ?? 200) || 200));
  const { rows } = await getPool().query<ProjectAccessRequestBlockRow>(
    `SELECT
       b.project_id,
       b.blocker_account_id,
       NULLIF(BTRIM(CONCAT_WS(' ', blocker.first_name, blocker.last_name)), '') AS blocker_name,
       b.blocked_account_id,
       NULLIF(BTRIM(CONCAT_WS(' ', blocked.first_name, blocked.last_name)), '') AS blocked_name,
       blocked.first_name AS blocked_first_name,
       blocked.last_name AS blocked_last_name,
       blocked.profile AS blocked_profile,
       b.created,
       b.updated
     FROM project_access_request_blocks b
     LEFT JOIN accounts blocker ON blocker.account_id=b.blocker_account_id
     LEFT JOIN accounts blocked ON blocked.account_id=b.blocked_account_id
     WHERE b.project_id=$1
     ORDER BY b.updated DESC
     LIMIT $2`,
    [project_id, maxRows],
  );
  return rows;
}

export async function unblockProjectAccessRequester({
  account_id,
  project_id,
  blocked_account_id,
}: {
  account_id?: string;
  project_id: string;
  blocked_account_id: string;
}): Promise<{
  unblocked: boolean;
  project_id: string;
  blocked_account_id: string;
}> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  ensureUuid(project_id, "project_id");
  ensureUuid(blocked_account_id, "blocked_account_id");
  await ensureProjectAccessRequestSchema();
  await assertCanManageProjectCollaborators({
    account_id,
    action: "unblock project access requesters",
    project_id,
  });
  const result = await getPool().query(
    `DELETE FROM project_access_request_blocks
      WHERE project_id=$1 AND blocked_account_id=$2`,
    [project_id, blocked_account_id],
  );
  return {
    unblocked: (result.rowCount ?? 0) > 0,
    project_id,
    blocked_account_id,
  };
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
       NULLIF(BTRIM(CONCAT_WS(' ', blocker.first_name, blocker.last_name)), '') AS blocker_name,
       b.blocked_account_id,
       NULLIF(BTRIM(CONCAT_WS(' ', blocked.first_name, blocked.last_name)), '') AS blocked_name,
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
  return await hydrateInviteBlockRows(rows, includeEmail);
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
  const project = await assertProjectCollaboratorAccessAllowRemote({
    account_id,
    project_id,
  });
  const includeEmail = await isAdmin(account_id);
  if (project.owning_bay_id !== getConfiguredBayId()) {
    return await hydrateCollaboratorRows(
      collaboratorRowsFromProjectUsers(project.users),
      includeEmail,
    );
  }
  const pool = getPool();
  const { rows } = await pool.query<ProjectCollaboratorRow>(
    `SELECT
       u.account_id_text::uuid AS account_id,
       NULLIF(BTRIM(CONCAT_WS(' ', a.first_name, a.last_name)), '') AS name,
       a.first_name,
       a.last_name,
       CASE WHEN $2::boolean THEN a.email_address ELSE NULL END AS email_address,
       a.last_active,
       (u.info ->> 'group')::text AS "group",
       u.info -> 'read_policy' AS read_policy
     FROM projects p
     CROSS JOIN LATERAL jsonb_each(p.users) AS u(account_id_text, info)
     LEFT JOIN accounts a ON a.account_id=u.account_id_text::uuid
     WHERE p.project_id=$1
       AND u.account_id_text ~* '^[0-9a-f-]{36}$'
       AND (u.info ->> 'group') IN ('owner','collaborator','viewer')
     ORDER BY
       CASE WHEN (u.info ->> 'group')='owner' THEN 0 ELSE 1 END,
       a.last_active DESC NULLS LAST,
       u.account_id_text::uuid`,
    [project_id, includeEmail],
  );
  return await hydrateCollaboratorRows(
    rows.filter((row) => PROJECT_ACCESS_GROUP_SET.has(row.group)),
    includeEmail,
  );
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
       u.account_id_text::uuid AS account_id,
       NULLIF(BTRIM(CONCAT_WS(' ', MAX(a.first_name), MAX(a.last_name))), '') AS name,
       MAX(a.first_name) AS first_name,
       MAX(a.last_name) AS last_name,
       CASE WHEN $2::boolean THEN MAX(a.email_address) ELSE NULL END AS email_address,
       MAX(a.last_active) AS last_active,
       COUNT(DISTINCT mp.project_id)::int AS shared_projects
     FROM my_projects mp
     CROSS JOIN LATERAL jsonb_each(mp.users) AS u(account_id_text, info)
     LEFT JOIN accounts a ON a.account_id=u.account_id_text::uuid
     WHERE u.account_id_text ~* '^[0-9a-f-]{36}$'
       AND u.account_id_text::uuid <> $1::uuid
       AND (u.info ->> 'group') IN ('owner','collaborator')
     GROUP BY
       u.account_id_text::uuid
     ORDER BY shared_projects DESC, MAX(a.last_active) DESC NULLS LAST, u.account_id_text::uuid
     LIMIT $3`,
    [account_id, includeEmail, maxRows],
  );
  return await hydrateMyCollaboratorRows(rows, includeEmail);
}

async function allowUrlsInEmails({
  account_id,
}: {
  project_id: string;
  account_id: string;
}) {
  const resolution = await resolveMembershipForAccount(account_id);
  const limits = getEffectiveMembershipUsageLimits(resolution);
  if (limits.invite_email_allow_urls != null) {
    return limits.invite_email_allow_urls;
  }
  return true;
}

async function canSendInviteEmail(account_id: string): Promise<boolean> {
  const resolution = await resolveMembershipForAccount(account_id);
  const limits = getEffectiveMembershipUsageLimits(resolution);
  return limits.invite_email_send_enabled !== false;
}

async function canCopyInviteLink(account_id: string): Promise<boolean> {
  const resolution = await resolveMembershipForAccount(account_id);
  const limits = getEffectiveMembershipUsageLimits(resolution);
  return limits.invite_email_link_copy_enabled !== false;
}

async function getInviteEmailResendCutoff(account_id: string): Promise<Date> {
  const resolution = await resolveMembershipForAccount(account_id);
  const limits = getEffectiveMembershipUsageLimits(resolution);
  const minutes =
    limits.invite_email_resend_cooldown_minutes ??
    RESEND_INVITE_INTERVAL_DAYS * 24 * 60;
  return new Date(Date.now() - Math.max(0, minutes) * 60_000);
}

async function normalizeInviteMessageForAccount({
  account_id,
  message,
}: {
  account_id: string;
  message?: string;
}): Promise<string | null> {
  const trimmed = `${message ?? ""}`.trim();
  if (!trimmed) {
    return null;
  }
  const resolution = await resolveMembershipForAccount(account_id);
  const limits = getEffectiveMembershipUsageLimits(resolution);
  const maxChars = limits.invite_email_custom_message_max_chars ?? 512;
  if (maxChars >= 0 && trimmed.length > maxChars) {
    throw new Error(
      `invite message is too long (${trimmed.length}/${maxChars}); shorten it or upgrade membership`,
    );
  }
  return trimmed;
}

async function normalizeAccessRequestMessageForAccount({
  account_id,
  message,
}: {
  account_id: string;
  message?: string;
}): Promise<string | null> {
  const trimmed = `${message ?? ""}`.trim();
  if (!trimmed) {
    return null;
  }
  const resolution = await resolveMembershipForAccount(account_id);
  const limits = getEffectiveMembershipUsageLimits(resolution);
  const maxChars = limits.invite_email_custom_message_max_chars ?? 512;
  if (maxChars >= 0 && trimmed.length > maxChars) {
    throw new Error(
      `access request message is too long (${trimmed.length}/${maxChars}); shorten it`,
    );
  }
  return trimmed;
}

async function assertEmailInviteCreationLimits({
  account_id,
  project_id,
  context,
  recipientCount,
  scope,
}: {
  account_id: string;
  project_id: string;
  context?: Record<string, unknown>;
  recipientCount: number;
  scope?: string;
}): Promise<void> {
  const resolution = await resolveMembershipForAccount(account_id);
  const limits = getEffectiveMembershipUsageLimits(resolution);
  const batchLimit = limits.invite_email_recipients_per_batch;
  if (batchLimit != null && recipientCount > batchLimit) {
    throw new Error(
      `too many invite recipients (${recipientCount}/${batchLimit}); send a smaller batch or upgrade membership`,
    );
  }
  const pendingLimit = limits.invite_email_pending_per_project;
  if (pendingLimit != null) {
    await ensureProjectCollabInviteEmailTokenSchema();
    const { rows } = await getPool().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM project_collab_invites
        WHERE project_id=$1
          AND status='pending'
          AND invite_source IN ('email', 'course_email')`,
      [project_id],
    );
    const current = rows[0]?.count ?? 0;
    if (current + recipientCount > pendingLimit) {
      throw new Error(
        `project pending email invite limit reached (${current}/${pendingLimit}); revoke pending invites or upgrade membership`,
      );
    }
  }
  if (scope === COURSE_EMAIL_INVITE_SCOPE) {
    const course_project_id =
      typeof context?.course_project_id === "string"
        ? context.course_project_id.trim()
        : "";
    if (!course_project_id) {
      throw new Error("course invite context is missing course_project_id");
    }
    const pendingCourseLimit = limits.invite_email_pending_per_course;
    if (pendingCourseLimit != null) {
      await ensureProjectCollabInviteEmailTokenSchema();
      const { rows } = await getPool().query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM project_collab_invites
          WHERE inviter_account_id=$1
            AND status='pending'
            AND scope=$2
            AND context ->> 'course_project_id' = $3`,
        [account_id, COURSE_EMAIL_INVITE_SCOPE, course_project_id],
      );
      const current = rows[0]?.count ?? 0;
      if (current + recipientCount > pendingCourseLimit) {
        throw new Error(
          `course pending email invite limit reached (${current}/${pendingCourseLimit}); revoke pending invites or upgrade membership`,
        );
      }
    }
    await assertCourseStudentInviteLimit({
      course_project_id,
      resolution,
      additional: recipientCount,
    });
  }
  const hourlyLimit = limits.invite_email_hourly_count;
  if (hourlyLimit != null) {
    const { rows } = await getPool().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM project_collab_invites
        WHERE inviter_account_id=$1
          AND invite_source IN ('email', 'course_email')
          AND created > NOW() - INTERVAL '1 hour'`,
      [account_id],
    );
    const current = rows[0]?.count ?? 0;
    if (current + recipientCount > hourlyLimit) {
      throw new Error(
        `hourly email invite limit reached (${current}/${hourlyLimit}); try again later or upgrade membership`,
      );
    }
  }
  const dailyLimit = limits.invite_email_daily_count;
  if (dailyLimit != null) {
    const { rows } = await getPool().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM project_collab_invites
        WHERE inviter_account_id=$1
          AND invite_source IN ('email', 'course_email')
          AND created > NOW() - INTERVAL '1 day'`,
      [account_id],
    );
    const current = rows[0]?.count ?? 0;
    if (current + recipientCount > dailyLimit) {
      throw new Error(
        `daily email invite limit reached (${current}/${dailyLimit}); try again later or upgrade membership`,
      );
    }
  }
}

function normalizeInviteEmail(email: string): string {
  if (!is_valid_email_address(email)) {
    throw Error(`invalid email address '${email}'`);
  }
  const normalized = lower_email_address(email);
  if (normalized.length >= 128) {
    throw Error(`email address must be at most 128 characters: '${email}'`);
  }
  return normalized;
}

async function assertCanManageProjectCollaborators({
  account_id,
  action,
  project_id,
}: {
  account_id: string;
  action: string;
  project_id: string;
}): Promise<void> {
  if (await isAdmin(account_id)) {
    return;
  }
  const { rows } = await getPool().query<{
    actor_group: string | null;
    manage_users_owner_only: boolean | null;
  }>(
    `SELECT users -> $2::text ->> 'group' AS actor_group,
            COALESCE(manage_users_owner_only, false) AS manage_users_owner_only
       FROM projects
      WHERE project_id=$1
      LIMIT 1`,
    [project_id, account_id],
  );
  const row = rows[0];
  if (row?.actor_group === "owner") {
    return;
  }
  if (row?.actor_group !== "collaborator") {
    throw new Error(`only project collaborators can ${action}`);
  }
  if (!row?.manage_users_owner_only) {
    return;
  }
  throw new Error(
    `only project owners can ${action} when owner-only collaborator management is enabled`,
  );
}

async function createEmailProjectInvite({
  account_id,
  context,
  project_id,
  email_address,
  message,
  scope = EMAIL_INVITE_SCOPE,
  invite_role,
  read_policy,
}: {
  account_id: string;
  context?: Record<string, unknown>;
  project_id: string;
  email_address: string;
  message?: string;
  scope?: string;
  invite_role?: Exclude<ProjectUserRole, "owner">;
  read_policy?: ProjectViewerReadPolicy | null;
}): Promise<{
  created: boolean;
  invite: ProjectCollabInviteRow;
  invite_url: string;
}> {
  await ensureProjectCollabInviteEmailTokenSchema();
  const normalizedEmail = normalizeInviteEmail(email_address);
  const normalizedMessage = await normalizeInviteMessageForAccount({
    account_id,
    message,
  });
  const email_hash = await hashInviteEmail(normalizedEmail);
  const pool = getPool();
  const role = normalizeInviteRole(invite_role);
  if (scope !== EMAIL_INVITE_SCOPE && role !== "collaborator") {
    throw new Error("viewer invites are only supported for project invites");
  }
  const policy = normalizeInviteReadPolicy({ invite_role: role, read_policy });

  const { rows: existingRows } = await pool.query<{
    invite_id: string;
    token_hash: string | null;
    token_ciphertext: string;
  }>(
    `SELECT invite_id, token_hash, token_ciphertext
       FROM project_collab_invites
      WHERE project_id=$1
        AND inviter_account_id=$2
        AND email_hash=$3
        AND status='pending'
        AND invite_source=$4
        AND scope=$5
        AND COALESCE(invite_role, 'collaborator')=$6
      ORDER BY created DESC
      LIMIT 1`,
    [project_id, account_id, email_hash, EMAIL_INVITE_SOURCE, scope, role],
  );
  const existing = existingRows[0];
  if (existing) {
    const token = await decryptInviteValue(
      EMAIL_INVITE_TOKEN_AAD,
      existing.token_ciphertext,
    );
    const token_hash = await ensureBayIndependentInviteTokenHash({
      invite_id: existing.invite_id,
      current_token_hash: existing.token_hash,
      token,
    });
    const invite = await fetchInviteById(existing.invite_id, false);
    if (!invite) {
      throw new Error("failed to load existing email invite");
    }
    await registerEmailInviteDirectory({
      invite_id: existing.invite_id,
      project_id,
      token_hash,
      scope,
    });
    const url = await inviteUrl({ token });
    return {
      created: false,
      invite: {
        ...invite,
        target_email: normalizedEmail,
        invite_url: url,
      },
      invite_url: url,
    };
  }

  if (role === "collaborator") {
    await assertProjectCollaboratorInviteLimit({ project_id });
  }
  const token = generateInviteToken();
  const invite_id = uuid();
  const token_hash = await hashProjectCollabInviteToken(token);
  const token_ciphertext = await encryptInviteValue(
    EMAIL_INVITE_TOKEN_AAD,
    token,
  );
  const email_ciphertext = await encryptInviteValue(
    EMAIL_INVITE_EMAIL_AAD,
    normalizedEmail,
  );
  const token_hint = token.slice(-6);
  await pool.query(
    `INSERT INTO project_collab_invites
      (invite_id, project_id, inviter_account_id, invitee_account_id,
       invite_source, email_hash, email_ciphertext, token_hash, token_ciphertext,
       token_hint, invite_role, read_policy, status, message, scope, context,
       created, updated)
     VALUES
      ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'pending',
       $12, $13, $14::jsonb, NOW(), NOW())`,
    [
      invite_id,
      project_id,
      account_id,
      EMAIL_INVITE_SOURCE,
      email_hash,
      email_ciphertext,
      token_hash,
      token_ciphertext,
      token_hint,
      role,
      JSON.stringify(policy),
      normalizedMessage || null,
      scope,
      JSON.stringify(context ?? {}),
    ],
  );
  const invite = await fetchInviteById(invite_id, false);
  if (!invite) {
    throw new Error("failed to load created email invite");
  }
  await registerEmailInviteDirectory({
    invite_id,
    project_id,
    token_hash,
    scope,
  });
  const url = await inviteUrl({ token });
  return {
    created: true,
    invite: {
      ...invite,
      target_email: normalizedEmail,
      invite_url: url,
    },
    invite_url: url,
  };
}

export async function copyEmailProjectInviteLink({
  account_id,
  invite_id,
}: {
  account_id?: string;
  invite_id: string;
  project_id?: string;
}): Promise<{ invite_id: string; invite_url: string; expires?: Date | null }> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  if (!(await canCopyInviteLink(account_id))) {
    throw new Error("copying invite links is not enabled for this account");
  }
  ensureUuid(invite_id, "invite_id");
  await ensureProjectCollabInviteEmailTokenSchema();
  const { rows } = await getPool().query<{
    project_id: string;
    inviter_account_id: string;
    token_hash: string | null;
    token_ciphertext: string | null;
    scope: string | null;
    status: string;
    created: Date;
  }>(
    `SELECT project_id, inviter_account_id, token_hash, token_ciphertext,
            scope, status, created
       FROM project_collab_invites
      WHERE invite_id=$1
        AND invite_source IN ('email', 'course_email')
      LIMIT 1`,
    [invite_id],
  );
  const row = rows[0];
  if (!row || !row.token_ciphertext) {
    throw new Error(`invite '${invite_id}' not found`);
  }
  if (row.inviter_account_id !== account_id) {
    await assertCanCopyEmailInviteLink({
      account_id,
      project_id: row.project_id,
    });
  }
  if (row.status !== "pending") {
    throw new Error(`invite is not pending (status=${row.status})`);
  }
  const token = await decryptInviteValue(
    EMAIL_INVITE_TOKEN_AAD,
    row.token_ciphertext,
  );
  const token_hash = await ensureBayIndependentInviteTokenHash({
    invite_id,
    current_token_hash: row.token_hash,
    token,
  });
  await registerEmailInviteDirectory({
    invite_id,
    project_id: row.project_id,
    token_hash,
    scope: row.scope,
  });
  return {
    invite_id,
    invite_url: await inviteUrl({ token }),
    expires: new Date(
      new Date(row.created).valueOf() +
        EMAIL_ONLY_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
    ),
  };
}

async function assertCanCopyEmailInviteLink({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<void> {
  if (await isAdmin(account_id)) {
    return;
  }
  const { rows } = await getPool().query<{ is_owner: boolean }>(
    `SELECT (users -> $2::text ->> 'group') = 'owner' AS is_owner
       FROM projects
      WHERE project_id=$1
      LIMIT 1`,
    [project_id, account_id],
  );
  if (rows[0]?.is_owner) {
    return;
  }
  throw new Error(
    "only the invite sender or a project owner can copy this invite link",
  );
}

export async function redeemEmailProjectInvite({
  account_id,
  invite_id,
  token,
  project_id,
  trustedProductAccessChecked,
}: {
  account_id?: string;
  invite_id: string;
  token: string;
  project_id?: string;
  trustedProductAccessChecked?: boolean;
}): Promise<ProjectCollabInviteRow> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  ensureUuid(invite_id, "invite_id");
  if (!trustedProductAccessChecked) {
    await assertAccountTrustedForProductAccess(
      account_id,
      "accept collaboration invites",
    );
  }
  const pool = getPool();
  const invite = await getPendingEmailCollabInviteForToken({
    invite_id,
    project_id,
    token,
  });
  await assertInviteSenderCanStillGrantAccess({ pool, invite });
  const role = normalizeInviteRole(invite.invite_role);
  const { rows: collabRows } = await pool.query<{
    existing_group: string | null;
  }>(
    `SELECT users -> $2::text ->> 'group' AS existing_group
       FROM projects
      WHERE project_id=$1
      LIMIT 1`,
    [invite.project_id, account_id],
  );
  const existingGroup = collabRows[0]?.existing_group;
  const needsGrant =
    existingGroup !== "owner" &&
    existingGroup !== "collaborator" &&
    !(existingGroup === "viewer" && role === "viewer");
  const needsUpgrade = existingGroup === "viewer" && role === "collaborator";
  if (needsGrant || needsUpgrade) {
    await addUserToProjectForAcceptedInvite({
      project_id: invite.project_id,
      account_id,
      invite_role: invite.invite_role,
      read_policy: invite.read_policy,
    });
    await syncProjectUsersOnHostBestEffort(
      invite.project_id,
      "accept email token invite",
    );
  }
  const loaded = await getCanonicalCollabInvite(pool, invite_id);
  if (loaded?.scope === COURSE_EMAIL_INVITE_SCOPE) {
    await pool.query(
      `UPDATE projects
          SET course=jsonb_set(
                COALESCE(course, '{}'::jsonb),
                '{account_id}',
                to_jsonb($2::text),
                true
              )
        WHERE project_id=$1`,
      [invite.project_id, account_id],
    );
  }
  await pool.query(
    `UPDATE project_collab_invites
        SET status='accepted',
            responder_action='accept',
            accepted_account_id=$2,
            responded=NOW(),
            updated=NOW()
      WHERE invite_id=$1`,
    [invite_id, account_id],
  );
  await registerEmailInviteDirectory({
    invite_id,
    project_id: invite.project_id,
    token_hash: invite.token_hash,
    scope: invite.scope,
    status: "accepted",
  });
  await publishProjectAccountFeedEventsBestEffort({
    project_id: invite.project_id,
  });
  const updated = await fetchInviteById(invite_id, await isAdmin(account_id));
  if (!updated) {
    throw new Error("failed to load invite response");
  }
  return updated;
}

export async function previewEmailProjectInvite({
  invite_id,
  token,
  project_id,
}: {
  account_id?: string;
  invite_id: string;
  token: string;
  project_id?: string;
}): Promise<ProjectCollabInviteRow> {
  await getPendingEmailCollabInviteForToken({ invite_id, project_id, token });
  const updated = await fetchInviteById(invite_id, false);
  if (!updated) {
    throw new Error("failed to load invite");
  }
  return updated;
}

export async function respondEmailProjectInvite({
  account_id,
  action,
  invite_id,
  token,
  project_id,
  trustedProductAccessChecked,
}: {
  account_id?: string;
  action: ProjectCollabInviteAction;
  invite_id: string;
  token: string;
  project_id?: string;
  trustedProductAccessChecked?: boolean;
}): Promise<ProjectCollabInviteRow> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  const normalizedAction = normalizeInviteAction(action);
  if (normalizedAction === "accept") {
    return await redeemEmailProjectInvite({
      account_id,
      invite_id,
      token,
      project_id,
      trustedProductAccessChecked,
    });
  }
  if (normalizedAction === "revoke") {
    throw new Error("invite links cannot be revoked by recipients");
  }
  const invite = await getPendingEmailCollabInviteForToken({
    invite_id,
    project_id,
    token,
  });
  const nextStatus: ProjectCollabInviteStatus =
    normalizedAction === "block" ? "blocked" : "declined";
  const pool = getPool();
  if (normalizedAction === "block") {
    await pool.query(
      `INSERT INTO project_collab_invite_blocks
        (blocker_account_id, blocked_account_id, created, updated)
       VALUES
        ($1, $2, NOW(), NOW())
       ON CONFLICT (blocker_account_id, blocked_account_id)
       DO UPDATE SET updated=EXCLUDED.updated`,
      [account_id, invite.inviter_account_id],
    );
  }
  await pool.query(
    `UPDATE project_collab_invites
        SET status=$2, responder_action=$3, responded=NOW(), updated=NOW()
      WHERE invite_id=$1`,
    [invite_id, nextStatus, normalizedAction],
  );
  await registerEmailInviteDirectory({
    invite_id,
    project_id: invite.project_id,
    token_hash: invite.token_hash,
    scope: invite.scope,
    status: nextStatus,
  });
  const updated = await fetchInviteById(invite_id, false);
  if (!updated) {
    throw new Error("failed to load invite response");
  }
  return updated;
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
    invite_role?: Exclude<ProjectUserRole, "owner">;
    read_policy?: ProjectViewerReadPolicy | null;
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
      invite_role: opts.invite_role,
      read_policy: opts.read_policy,
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
  if (!(await canSendInviteEmail(account_id))) {
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
  if (
    when_sent &&
    when_sent >= (await getInviteEmailResendCutoff(account_id))
  ) {
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
    send_email?: boolean;
    invite_context?: Record<string, unknown>;
    invite_scope?: string;
    invite_role?: Exclude<ProjectUserRole, "owner">;
    read_policy?: ProjectViewerReadPolicy | null;
  };
}): Promise<{ invites: ProjectCollabInviteRow[] } & InviteEmailDeliveryStatus> {
  await assertLocalProjectCollaborator({
    account_id,
    project_id: opts.project_id,
  });
  await assertCanManageProjectCollaborators({
    account_id,
    action: "invite collaborators",
    project_id: opts.project_id,
  });
  await assertAccountTrustedForProductAccess(
    account_id,
    "invite collaborators",
  );
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
  await assertProjectCollaboratorInviteLimit({
    project_id: opts.project_id,
    additional: to.length,
  });
  await assertEmailInviteCreationLimits({
    account_id,
    context: opts.invite_context,
    project_id: opts.project_id,
    recipientCount: to.length,
    scope: opts.invite_scope,
  });

  // Helper for inviting one user by email
  let email_sent = false;
  let email_available = true;
  let manual_delivery_required = false;
  let email_blocked_reason: InviteEmailBlockedReason | null = null;
  const blockEmail = ({
    reason,
    available = true,
  }: {
    reason: InviteEmailBlockedReason;
    available?: boolean;
  }) => {
    manual_delivery_required = true;
    if (!available) {
      email_available = false;
    }
    email_blocked_reason ??= reason;
  };
  const invite_user = async (email_address: string) => {
    dbg(`inviting ${email_address}`);
    email_address = normalizeInviteEmail(email_address);

    const created = await createEmailProjectInvite({
      account_id,
      context: opts.invite_context,
      project_id: opts.project_id,
      email_address,
      message: opts.message,
      scope: opts.invite_scope,
      invite_role: opts.invite_role,
      read_policy: opts.read_policy,
    });

    // 3. Has email been sent recently?
    if (opts.send_email === false) {
      blockEmail({ reason: "send_disabled_by_request" });
      return created.invite;
    }
    if (!(await canSendInviteEmail(account_id))) {
      blockEmail({ reason: "tier_disallows_email" });
      return created.invite;
    }

    const when_sent = await callback2(database.when_sent_project_invite, {
      project_id: opts.project_id,
      to: email_address,
    });
    if (
      when_sent &&
      when_sent >= (await getInviteEmailResendCutoff(account_id))
    ) {
      // recent email -- nothing more to do
      blockEmail({ reason: "cooldown" });
      return created.invite;
    }

    // 4. Get settings
    const settings = await callback2(database.get_server_settings_cached);
    if (!settings) {
      blockEmail({ reason: "email_not_configured", available: false });
      return created.invite;
    }

    // 5. Send email

    // Compose subject
    const subject = opts.subject ? opts.subject : "CoCalc Invitation";

    dbg(`send_email invite to ${email_address}`);
    try {
      const sendMessage = await callback2<string | undefined>(
        send_invite_email,
        {
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
          link2proj: created.invite_url,
          settings,
        },
      );
      if (`${sendMessage ?? ""}`.trim()) {
        blockEmail({
          reason: emailUnavailableFromSendMessage(sendMessage)
            ? "email_not_configured"
            : "tier_disallows_email",
          available: !emailUnavailableFromSendMessage(sendMessage),
        });
        return created.invite;
      }
      await getPool().query(
        `UPDATE project_collab_invites
            SET last_sent=NOW(), resend_count=COALESCE(resend_count, 0) + 1, updated=NOW()
          WHERE invite_id=$1`,
        [created.invite.invite_id],
      );
      email_sent = true;
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
    return created.invite;
  };

  // If any invite_user throws, its an error
  const invites = await Promise.all(to.map((email) => invite_user(email)));
  return {
    invites,
    email_sent,
    email_available,
    manual_delivery_required,
    email_blocked_reason,
  };
}
