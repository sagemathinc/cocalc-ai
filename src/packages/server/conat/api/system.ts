import getCustomize from "@cocalc/database/settings/customize";
export { getCustomize };
import { getFrontendSourceFingerprint as getFrontendSourceFingerprint0 } from "@cocalc/backend/frontend-build-fingerprint";
import {
  listConfiguredBays,
  resolveAccountHomeBay,
  resolveHostBay,
  resolveProjectOwningBay,
} from "@cocalc/server/bay-directory";
import { backfillBayOwnership as backfillBayOwnership0 } from "@cocalc/server/bay-backfill";
import { rebuildAccountProjectIndex as rebuildAccountProjectIndex0 } from "@cocalc/database/postgres/account-project-index";
import {
  drainAccountProjectIndexProjection as drainAccountProjectIndexProjection0,
  getAccountProjectIndexProjectionBacklogStatus,
} from "@cocalc/database/postgres/account-project-index-projector";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { record_user_tracking } from "@cocalc/database/postgres/account/user-tracking";
import { db } from "@cocalc/database";
import manageApiKeys from "@cocalc/server/api/manage";
export { manageApiKeys };
import { type UserSearchResult } from "@cocalc/util/db-schema/accounts";
import isAdmin from "@cocalc/server/accounts/is-admin";
import search from "@cocalc/server/accounts/search";
import createAccount from "@cocalc/server/accounts/create-account";
export { getNames } from "@cocalc/server/accounts/get-name";
import { callback2 } from "@cocalc/util/async-utils";
import getLogger from "@cocalc/backend/logger";
import basePath from "@cocalc/backend/base-path";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import {
  getExternalCredential,
  hasExternalCredential,
  listExternalCredentials as listExternalCredentialsStore,
  revokeExternalCredential as revokeExternalCredentialStore,
  upsertExternalCredential,
} from "@cocalc/server/external-credentials/store";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { to_bool } from "@cocalc/util/db-schema/site-defaults";
import { is_valid_email_address } from "@cocalc/util/misc";
import { v4 as uuid } from "uuid";
import { secureRandomString } from "@cocalc/backend/misc";
import {
  testR2Credentials as testR2Credentials0,
  type R2CredentialsTestResult,
} from "@cocalc/server/project-backup/r2";
import {
  listRootfsImagesAdmin,
  listVisibleRootfsImages,
  requestRootfsImageDeletion as requestRootfsImageDeletion0,
  saveRootfsImage,
} from "@cocalc/server/rootfs/catalog";
import { runPendingRootfsReleaseGc } from "@cocalc/server/rootfs/releases";
import type {
  ProjectRootfsStateEntry,
  ProjectRootfsPublishLroRef,
  PublishProjectRootfsBody,
  RootfsCatalogSaveBody,
} from "@cocalc/util/rootfs-images";
import {
  getProjectRootfsStates as getProjectRootfsStates0,
  setProjectRootfsImageWithRollback,
} from "@cocalc/server/projects/rootfs-state";
import { getAssignedProjectHostInfo } from "@cocalc/server/conat/project-host-assignment";
import { createLro } from "@cocalc/server/lro/lro-db";
import { lroStreamName } from "@cocalc/conat/lro/names";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import {
  type BrowserSessionLiveInfo,
  listBrowserSessionsForAccount,
  removeBrowserSessionRecord,
  upsertBrowserSessionRecord,
} from "./browser-sessions";
import { createRememberMeCookie } from "@cocalc/server/auth/remember-me";
import {
  getProjectAppPublicPolicy as getProjectAppPublicPolicyRaw,
  getPublicAppRouteByHostname as getPublicAppRouteByHostnameRaw,
  releaseProjectAppPublicSubdomain as releaseProjectAppPublicSubdomainRaw,
  resolvePublicAppDnsTarget,
  reserveProjectAppPublicSubdomain as reserveProjectAppPublicSubdomainRaw,
} from "@cocalc/server/app-public-subdomains";
import { conat } from "@cocalc/backend/conat";
import { sysApiMany } from "@cocalc/conat/core/sys";
import type { ConnectionStats } from "@cocalc/conat/core/types";
import { getParallelOpsStatus as getParallelOpsStatus0 } from "@cocalc/server/lro/worker-status";
import {
  clearParallelOpsLimitOverride,
  getEffectiveParallelOpsLimit,
  setParallelOpsLimitOverride,
  type ParallelOpsLimitScopeType,
} from "@cocalc/server/lro/worker-config";
import { getParallelOpsWorkerRegistration } from "@cocalc/server/lro/worker-registry";
import { getProjectHostDefaultParallelLimit } from "@cocalc/server/lro/project-host-defaults";
import { getAccountProjectIndexProjectionMaintenanceStatus } from "@cocalc/server/projections/account-project-index-maintenance";

const logger = getLogger("server:conat:api:system");
const ROOTFS_PUBLISH_LRO_KIND = "project-rootfs-publish";
const DEFAULT_BROWSER_SIGN_IN_COOKIE_MAX_AGE_MS = 12 * 3600 * 1000;

export function ping() {
  return { now: Date.now() };
}

export async function terminate() {}

export async function listBays() {
  return await listConfiguredBays();
}

export async function getAccountBay({
  account_id,
  user_account_id,
}: {
  account_id?: string;
  user_account_id?: string;
}) {
  return await resolveAccountHomeBay({ account_id, user_account_id });
}

export async function getProjectBay({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}) {
  return await resolveProjectOwningBay({ account_id, project_id });
}

export async function getHostBay({
  account_id,
  host_id,
}: {
  account_id?: string;
  host_id: string;
}) {
  return await resolveHostBay({ account_id, host_id });
}

export async function backfillBayOwnership({
  account_id,
  bay_id,
  dry_run = true,
  limit_per_table,
}: {
  account_id?: string;
  bay_id?: string;
  dry_run?: boolean;
  limit_per_table?: number;
}) {
  await assertAdmin(account_id);
  return await backfillBayOwnership0({
    bay_id,
    dry_run,
    limit_per_table,
  });
}

export async function rebuildAccountProjectIndex({
  account_id,
  target_account_id,
  dry_run = true,
}: {
  account_id?: string;
  target_account_id: string;
  dry_run?: boolean;
}) {
  await assertAdmin(account_id);
  return await rebuildAccountProjectIndex0({
    account_id: target_account_id,
    bay_id: getConfiguredBayId(),
    dry_run,
  });
}

export async function drainAccountProjectIndexProjection({
  account_id,
  bay_id,
  limit,
  dry_run = true,
}: {
  account_id?: string;
  bay_id?: string;
  limit?: number;
  dry_run?: boolean;
}) {
  await assertAdmin(account_id);
  return await drainAccountProjectIndexProjection0({
    bay_id: bay_id?.trim() || getConfiguredBayId(),
    limit,
    dry_run,
  });
}

export async function getAccountProjectIndexProjectionStatus({
  account_id,
}: {
  account_id?: string;
}) {
  await assertAdmin(account_id);
  const bay_id = getConfiguredBayId();
  return {
    bay_id,
    backlog: await getAccountProjectIndexProjectionBacklogStatus({
      bay_id,
    }),
    maintenance: getAccountProjectIndexProjectionMaintenanceStatus(),
  };
}

export async function getParallelOpsStatus({
  account_id,
}: {
  account_id?: string;
}) {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await getParallelOpsStatus0();
}

export async function getProjectHostParallelOpsLimit({
  account_id,
  host_id,
  worker_kind,
}: {
  account_id?: string;
  host_id?: string;
  worker_kind: string;
}) {
  const worker = getParallelOpsWorkerRegistration(worker_kind);
  if (!worker) {
    throw Error(`unknown worker_kind '${worker_kind}'`);
  }
  if (worker.scope_model !== "per-project-host") {
    throw Error(
      `worker '${worker_kind}' does not use per-project-host limit resolution`,
    );
  }
  const effectiveHostId = `${host_id ?? ""}`.trim();
  if (!effectiveHostId) {
    if (!account_id || !(await isAdmin(account_id))) {
      throw Error("must be a host or an admin");
    }
    throw Error("host_id is required");
  }
  const base = worker.getLimitSnapshot();
  let default_limit = base.default_limit ?? base.effective_limit;
  if (
    effectiveHostId &&
    (worker_kind === "project-rootfs-publish-host" ||
      worker_kind === "project-host-backup-execution")
  ) {
    default_limit = await getProjectHostDefaultParallelLimit({
      host_id: effectiveHostId,
    });
  }
  if (default_limit == null) {
    throw Error(`worker '${worker_kind}' does not define a default limit`);
  }
  const { value, source } = await getEffectiveParallelOpsLimit({
    worker_kind,
    default_limit,
    scope_type: "project_host",
    scope_id: effectiveHostId,
  });
  return {
    worker_kind,
    scope_type: "project_host" as const,
    scope_id: effectiveHostId,
    default_limit,
    configured_limit: source === "db-override" ? value : null,
    effective_limit: value,
    config_source:
      source === "db-override"
        ? "db-override"
        : source === "env-debug-cap"
          ? "env-debug-cap"
          : base.config_source,
  };
}

function validateParallelOpsScopeType(
  scope_type: string | undefined,
): ParallelOpsLimitScopeType {
  const normalized = `${scope_type ?? "global"}`.trim();
  if (
    normalized === "global" ||
    normalized === "provider" ||
    normalized === "project_host"
  ) {
    return normalized;
  }
  throw Error(`invalid scope_type '${scope_type}'`);
}

async function assertAdmin(account_id?: string): Promise<void> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
}

export async function setParallelOpsLimit({
  account_id,
  worker_kind,
  scope_type,
  scope_id,
  limit_value,
  note,
}: {
  account_id?: string;
  worker_kind: string;
  scope_type?: string;
  scope_id?: string;
  limit_value: number;
  note?: string;
}) {
  await assertAdmin(account_id);
  const worker = getParallelOpsWorkerRegistration(worker_kind);
  if (!worker) {
    throw Error(`unknown worker_kind '${worker_kind}'`);
  }
  const normalizedScopeType = validateParallelOpsScopeType(scope_type);
  if (!worker.dynamic_limit_supported) {
    throw Error(`dynamic limits are not supported for '${worker_kind}'`);
  }
  if (worker.scope_model === "global") {
    if (normalizedScopeType !== "global") {
      throw Error(
        `scope_type '${normalizedScopeType}' is not implemented for '${worker_kind}'`,
      );
    }
  } else if (worker.scope_model === "per-project-host") {
    if (normalizedScopeType !== "project_host") {
      throw Error(
        `scope_type '${normalizedScopeType}' is not implemented for '${worker_kind}'`,
      );
    }
    if (!`${scope_id ?? ""}`.trim()) {
      throw Error(`scope_id is required for '${worker_kind}'`);
    }
  } else if (worker.scope_model === "per-provider") {
    if (
      normalizedScopeType !== "global" &&
      normalizedScopeType !== "provider"
    ) {
      throw Error(
        `scope_type '${normalizedScopeType}' is not implemented for '${worker_kind}'`,
      );
    }
    if (normalizedScopeType === "provider" && !`${scope_id ?? ""}`.trim()) {
      throw Error(`scope_id is required for '${worker_kind}'`);
    }
  } else {
    throw Error(
      `non-global limit overrides are not implemented for '${worker_kind}'`,
    );
  }
  if (!Number.isInteger(limit_value) || limit_value < 1) {
    throw Error("limit_value must be a positive integer");
  }
  return await setParallelOpsLimitOverride({
    worker_kind,
    scope_type: normalizedScopeType,
    scope_id,
    limit_value,
    updated_by: account_id,
    note,
  });
}

export async function clearParallelOpsLimit({
  account_id,
  worker_kind,
  scope_type,
  scope_id,
}: {
  account_id?: string;
  worker_kind: string;
  scope_type?: string;
  scope_id?: string;
}) {
  await assertAdmin(account_id);
  const worker = getParallelOpsWorkerRegistration(worker_kind);
  if (!worker) {
    throw Error(`unknown worker_kind '${worker_kind}'`);
  }
  const normalizedScopeType = validateParallelOpsScopeType(scope_type);
  if (!worker.dynamic_limit_supported) {
    throw Error(`dynamic limits are not supported for '${worker_kind}'`);
  }
  if (worker.scope_model === "global") {
    if (normalizedScopeType !== "global") {
      throw Error(
        `scope_type '${normalizedScopeType}' is not implemented for '${worker_kind}'`,
      );
    }
  } else if (worker.scope_model === "per-project-host") {
    if (normalizedScopeType !== "project_host") {
      throw Error(
        `scope_type '${normalizedScopeType}' is not implemented for '${worker_kind}'`,
      );
    }
    if (!`${scope_id ?? ""}`.trim()) {
      throw Error(`scope_id is required for '${worker_kind}'`);
    }
  } else if (worker.scope_model === "per-provider") {
    if (
      normalizedScopeType !== "global" &&
      normalizedScopeType !== "provider"
    ) {
      throw Error(
        `scope_type '${normalizedScopeType}' is not implemented for '${worker_kind}'`,
      );
    }
    if (normalizedScopeType === "provider" && !`${scope_id ?? ""}`.trim()) {
      throw Error(`scope_id is required for '${worker_kind}'`);
    }
  } else {
    throw Error(
      `non-global limit overrides are not implemented for '${worker_kind}'`,
    );
  }
  await clearParallelOpsLimitOverride({
    worker_kind,
    scope_type: normalizedScopeType,
    scope_id,
  });
}

export async function userTracking({
  event,
  value,
  account_id,
}: {
  event: string;
  value: object;
  account_id?: string;
}): Promise<void> {
  await record_user_tracking(db(), account_id!, event, value);
}

export async function logClientError({
  account_id,
  event,
  error,
}: {
  account_id?: string;
  event: string;
  error: string;
}): Promise<void> {
  await callback2(db().log_client_error, {
    event,
    error,
    account_id,
  });
}

export async function webappError(opts: object): Promise<void> {
  await callback2(db().webapp_error, opts);
}

export async function getFrontendSourceFingerprint() {
  return await getFrontendSourceFingerprint0();
}

export async function getRootfsCatalog(opts: { account_id?: string } = {}) {
  return await listVisibleRootfsImages(opts.account_id);
}

export async function getRootfsCatalogAdmin(
  opts: {
    account_id?: string;
  } = {},
) {
  return await listRootfsImagesAdmin(opts.account_id);
}

export async function saveRootfsCatalogEntry(
  opts: RootfsCatalogSaveBody & { account_id?: string },
) {
  const { account_id, ...body } = opts;
  if (!account_id) {
    throw Error("user must be signed in");
  }
  return await saveRootfsImage({ account_id, body });
}

export async function requestRootfsImageDeletion(opts: {
  account_id?: string;
  image_id: string;
  reason?: string;
}) {
  const { account_id, image_id, reason } = opts;
  if (!account_id) {
    throw Error("user must be signed in");
  }
  return await requestRootfsImageDeletion0({
    account_id,
    image_id,
    reason,
  });
}

export async function runRootfsReleaseGc(opts: {
  account_id?: string;
  limit?: number;
}) {
  const { account_id, limit } = opts;
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await runPendingRootfsReleaseGc({ limit });
}

async function publishQueuedLroSafe({ op }: { op: LroSummary }) {
  void publishLroSummary({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    summary: op,
  }).catch(() => {
    // best effort only; worker will publish later summaries
  });
  publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
    },
  }).catch(() => {});
}

export async function publishProjectRootfsImage(
  opts: PublishProjectRootfsBody & { account_id?: string },
): Promise<ProjectRootfsPublishLroRef> {
  const { account_id, project_id, ...body } = opts;
  if (!account_id) {
    throw Error("user must be signed in");
  }
  await assertLocalProjectCollaborator({ account_id, project_id });
  const op = await createLro({
    kind: ROOTFS_PUBLISH_LRO_KIND,
    scope_type: "project",
    scope_id: project_id,
    created_by: account_id,
    routing: "hub",
    dedupe_key: `${ROOTFS_PUBLISH_LRO_KIND}:${project_id}`,
    input: {
      project_id,
      ...body,
    },
    status: "queued",
  });
  await publishQueuedLroSafe({ op });
  return {
    op_id: op.op_id,
    scope_type: "project",
    scope_id: project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

export async function getProjectRootfsStates(opts: {
  account_id?: string;
  project_id: string;
}): Promise<ProjectRootfsStateEntry[]> {
  const { account_id, project_id } = opts;
  if (!account_id) {
    throw Error("user must be signed in");
  }
  await assertLocalProjectCollaborator({ account_id, project_id });
  return await getProjectRootfsStates0({ project_id });
}

export async function setProjectRootfsImage(opts: {
  account_id?: string;
  project_id: string;
  image: string;
  image_id?: string;
}): Promise<ProjectRootfsStateEntry[]> {
  const { account_id, project_id, image, image_id } = opts;
  if (!account_id) {
    throw Error("user must be signed in");
  }
  await assertLocalProjectCollaborator({ account_id, project_id });
  return await setProjectRootfsImageWithRollback({
    project_id,
    image,
    image_id,
    set_by_account_id: account_id,
  });
}

export {
  generateUserAuthToken,
  revokeUserAuthToken,
} from "@cocalc/server/auth/auth-token";

export async function userSearch({
  account_id,
  query,
  limit,
  admin,
  only_email,
}: {
  account_id?: string;
  query: string;
  limit?: number;
  admin?: boolean;
  only_email?: boolean;
}): Promise<UserSearchResult[]> {
  if (!account_id) {
    throw Error("You must be signed in to search for users.");
  }
  if (admin) {
    if (!(await isAdmin(account_id))) {
      throw Error("Must be an admin to do admin search.");
    }
  } else {
    if (limit != null && limit > 50) {
      // hard cap at 50... (for non-admin)
      limit = 50;
    }
  }
  return await search({ query, limit, admin, only_email });
}

import getEmailAddress from "@cocalc/server/accounts/get-email-address";
import { createReset } from "@cocalc/server/auth/password-reset";
export async function adminResetPasswordLink({
  account_id,
  user_account_id,
}: {
  account_id?: string;
  user_account_id: string;
}): Promise<string> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  const email = await getEmailAddress(user_account_id);
  if (!email) {
    throw Error("passwords are only defined for accounts with email");
  }
  const id = await createReset(email, "", 60 * 60 * 24); // 24 hour ttl seems reasonable for this.
  return `/auth/password-reset/${id}`;
}

function defaultUserNameFromEmail(email: string): {
  first_name: string;
  last_name: string;
} {
  const local = (email.split("@")[0] ?? "").trim();
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { first_name: "New", last_name: "User" };
  }
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: "User" };
  }
  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(" "),
  };
}

export async function adminCreateUser({
  account_id,
  email,
  password,
  first_name,
  last_name,
  no_first_project,
  tags,
}: {
  account_id?: string;
  email: string;
  password?: string;
  first_name?: string;
  last_name?: string;
  no_first_project?: boolean;
  tags?: string[];
}): Promise<{
  account_id: string;
  email_address: string;
  first_name: string;
  last_name: string;
  created_by: string;
  no_first_project: boolean;
  password_generated: boolean;
  generated_password?: string;
}> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }

  const emailAddress = `${email ?? ""}`.trim().toLowerCase();
  if (!is_valid_email_address(emailAddress)) {
    throw Error(`invalid email address '${email}'`);
  }
  const explicitPassword = typeof password === "string" ? password : "";
  const generatedPassword =
    explicitPassword.length > 0 ? undefined : await secureRandomString(24);
  const finalPassword =
    explicitPassword.length > 0 ? explicitPassword : generatedPassword!;
  if (!finalPassword) {
    throw Error("password must be non-empty");
  }

  const defaultName = defaultUserNameFromEmail(emailAddress);
  const firstName = `${first_name ?? ""}`.trim() || defaultName.first_name;
  const lastName = `${last_name ?? ""}`.trim() || defaultName.last_name;
  const nextAccountId = uuid();

  try {
    await createAccount({
      email: emailAddress,
      password: finalPassword,
      firstName,
      lastName,
      account_id: nextAccountId,
      owner_id: account_id,
      noFirstProject: !!no_first_project,
      tags: Array.isArray(tags) && tags.length ? tags : undefined,
      signupReason: "Admin created account",
    });
  } catch (err: any) {
    if (err?.code === "23505") {
      throw Error(`an account with email '${emailAddress}' already exists`);
    }
    throw err;
  }

  return {
    account_id: nextAccountId,
    email_address: emailAddress,
    first_name: firstName,
    last_name: lastName,
    created_by: account_id,
    no_first_project: !!no_first_project,
    password_generated: !!generatedPassword,
    generated_password: generatedPassword,
  };
}

import sendEmailVerification0 from "@cocalc/server/accounts/send-email-verification";

export async function sendEmailVerification({
  account_id,
  only_verify,
}: {
  account_id?: string;
  only_verify?: boolean;
}): Promise<void> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const resp = await sendEmailVerification0(account_id, only_verify);
  if (resp) {
    throw Error(resp);
  }
}

import { delete_passport } from "@cocalc/server/auth/sso/delete-passport";
export async function deletePassport(opts: {
  account_id: string;
  strategy: string;
  id: string;
}): Promise<void> {
  await delete_passport(db(), opts);
}

type AdminAssignedMembershipRow = {
  account_id: string;
  membership_class: string;
  assigned_by: string;
  assigned_at: Date;
  expires_at?: Date | null;
  notes?: string | null;
};

export async function getAdminAssignedMembership({
  account_id,
  user_account_id,
}: {
  account_id?: string;
  user_account_id: string;
}): Promise<AdminAssignedMembershipRow | undefined> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  const pool = db();
  const result = await pool.async_query({
    query: `SELECT account_id, membership_class, assigned_by, assigned_at, expires_at, notes
            FROM admin_assigned_memberships
            WHERE account_id=$1`,
    params: [user_account_id],
  });
  return result.rows?.[0] as AdminAssignedMembershipRow | undefined;
}

export async function setAdminAssignedMembership({
  account_id,
  user_account_id,
  membership_class,
  expires_at,
  notes,
}: {
  account_id?: string;
  user_account_id: string;
  membership_class: string;
  expires_at?: Date | null;
  notes?: string | null;
}): Promise<void> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  const pool = db();
  const assigned_at = new Date();
  const assigned_by = account_id;
  await pool.async_query({
    query: `INSERT INTO admin_assigned_memberships
              (account_id, membership_class, assigned_by, assigned_at, expires_at, notes)
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (account_id)
            DO UPDATE SET
              membership_class=EXCLUDED.membership_class,
              assigned_by=EXCLUDED.assigned_by,
              assigned_at=EXCLUDED.assigned_at,
              expires_at=EXCLUDED.expires_at,
              notes=EXCLUDED.notes`,
    params: [
      user_account_id,
      membership_class,
      assigned_by,
      assigned_at,
      expires_at ?? null,
      notes ?? null,
    ],
  });
}

export async function clearAdminAssignedMembership({
  account_id,
  user_account_id,
}: {
  account_id?: string;
  user_account_id: string;
}): Promise<void> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  const pool = db();
  await pool.async_query({
    query: "DELETE FROM admin_assigned_memberships WHERE account_id=$1",
    params: [user_account_id],
  });
}

import { sync as salesloftSync } from "@cocalc/server/salesloft/sync";
export async function adminSalesloftSync({
  account_id,
  account_ids,
}: {
  account_id?: string;
  account_ids: string[];
}) {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  (async () => {
    // we do not block on this
    try {
      await salesloftSync(account_ids);
    } catch (err) {
      logger.debug(`WARNING: issue syncing with salesloft -- ${err}`, {
        account_ids,
      });
    }
  })();
}

// user can sync themself with salesloft.
export const userSalesloftSync = reuseInFlight(
  async ({ account_id }: { account_id?: string }): Promise<void> => {
    if (account_id) {
      await salesloftSync([account_id]);
    }
  },
);

function parseMap(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const key in parsed) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        out[key] = value.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

function resolveSharedHomeMode():
  | "disabled"
  | "fallback"
  | "prefer"
  | "always" {
  const defaultMode =
    `${process.env.COCALC_PRODUCT ?? ""}`.trim().toLowerCase() === "launchpad"
      ? "disabled"
      : "fallback";
  const mode =
    `${process.env.COCALC_CODEX_AUTH_SHARED_HOME_MODE ?? defaultMode}`
      .trim()
      .toLowerCase();
  if (mode === "disabled") return "disabled";
  if (mode === "prefer" || mode === "always") return mode;
  return "fallback";
}

const CODEX_SUBSCRIPTION_KIND = "codex-subscription-auth-json";
const OPENAI_API_KEY_KIND = "openai-api-key";

function toExternalCredentialInfo(
  credential: Awaited<ReturnType<typeof getExternalCredential>> | undefined,
) {
  if (!credential) return undefined;
  return {
    id: credential.id,
    provider: credential.provider,
    kind: credential.kind,
    scope: credential.scope,
    owner_account_id: credential.owner_account_id,
    project_id: credential.project_id,
    organization_id: credential.organization_id,
    metadata: credential.metadata,
    created: credential.created,
    updated: credential.updated,
    revoked: credential.revoked,
    last_used: credential.last_used,
  };
}

async function assertProjectCollaborator(
  account_id: string,
  project_id: string,
): Promise<void> {
  await assertLocalProjectCollaborator({ account_id, project_id });
}

export async function listExternalCredentials({
  account_id,
  provider,
  kind,
  scope,
  include_revoked,
}: {
  account_id?: string;
  provider?: string;
  kind?: string;
  scope?: string;
  include_revoked?: boolean;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  return await listExternalCredentialsStore({
    owner_account_id: account_id,
    provider,
    kind,
    scope: scope as any,
    includeRevoked: !!include_revoked,
  });
}

export async function revokeExternalCredential({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  if (!id) {
    throw Error("id must be specified");
  }
  const revoked = await revokeExternalCredentialStore({
    id,
    owner_account_id: account_id,
  });
  return { revoked };
}

export async function setOpenAiApiKey({
  account_id,
  api_key,
  project_id,
}: {
  account_id?: string;
  api_key: string;
  project_id?: string;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const key = `${api_key ?? ""}`.trim();
  if (!key) {
    throw Error("api_key must not be empty");
  }

  if (project_id) {
    await assertProjectCollaborator(account_id, project_id);
    const result = await upsertExternalCredential({
      selector: {
        provider: "openai",
        kind: OPENAI_API_KEY_KIND,
        scope: "project",
        project_id,
      },
      payload: key,
      metadata: {
        source: "account-settings",
        actor_account_id: account_id,
      },
    });
    return { ...result, scope: "project" as const, project_id };
  }

  const result = await upsertExternalCredential({
    selector: {
      provider: "openai",
      kind: OPENAI_API_KEY_KIND,
      scope: "account",
      owner_account_id: account_id,
    },
    payload: key,
    metadata: {
      source: "account-settings",
      actor_account_id: account_id,
    },
  });
  return { ...result, scope: "account" as const };
}

export async function deleteOpenAiApiKey({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id?: string;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }

  if (project_id) {
    await assertProjectCollaborator(account_id, project_id);
    const existing = await getExternalCredential({
      selector: {
        provider: "openai",
        kind: OPENAI_API_KEY_KIND,
        scope: "project",
        project_id,
      },
      touchLastUsed: false,
    });
    if (!existing) {
      return { revoked: false, scope: "project" as const, project_id };
    }
    const revoked = await revokeExternalCredentialStore({
      id: existing.id,
    });
    return { revoked, scope: "project" as const, project_id };
  }

  const existing = await getExternalCredential({
    selector: {
      provider: "openai",
      kind: OPENAI_API_KEY_KIND,
      scope: "account",
      owner_account_id: account_id,
    },
    touchLastUsed: false,
  });
  if (!existing) {
    return { revoked: false, scope: "account" as const };
  }
  const revoked = await revokeExternalCredentialStore({
    id: existing.id,
    owner_account_id: account_id,
  });
  return { revoked, scope: "account" as const };
}

export async function getOpenAiApiKeyStatus({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id?: string;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  if (project_id) {
    await assertProjectCollaborator(account_id, project_id);
  }

  const [accountCredential, projectCredential] = await Promise.all([
    getExternalCredential({
      selector: {
        provider: "openai",
        kind: OPENAI_API_KEY_KIND,
        scope: "account",
        owner_account_id: account_id,
      },
      touchLastUsed: false,
    }),
    project_id
      ? getExternalCredential({
          selector: {
            provider: "openai",
            kind: OPENAI_API_KEY_KIND,
            scope: "project",
            project_id,
          },
          touchLastUsed: false,
        })
      : Promise.resolve(undefined),
  ]);

  return {
    account: toExternalCredentialInfo(accountCredential),
    project: toExternalCredentialInfo(projectCredential),
    project_id,
  };
}

export async function getCodexPaymentSource({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id?: string;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const projectKeys = parseMap(
    process.env.COCALC_CODEX_AUTH_PROJECT_OPENAI_KEYS_JSON,
  );
  const accountKeys = parseMap(
    process.env.COCALC_CODEX_AUTH_ACCOUNT_OPENAI_KEYS_JSON,
  );
  if (project_id) {
    await assertProjectCollaborator(account_id, project_id);
  }

  const settings = await getServerSettings();
  const hasSiteApiKey =
    to_bool(settings.openai_enabled) &&
    !!`${settings.openai_api_key ?? ""}`.trim();
  const [hasSubscription, hasProjectApiKeyStored, hasAccountApiKeyStored] =
    await Promise.all([
      hasExternalCredential({
        selector: {
          provider: "openai",
          kind: CODEX_SUBSCRIPTION_KIND,
          scope: "account",
          owner_account_id: account_id,
        },
      }),
      project_id
        ? hasExternalCredential({
            selector: {
              provider: "openai",
              kind: OPENAI_API_KEY_KIND,
              scope: "project",
              project_id,
            },
          })
        : Promise.resolve(false),
      hasExternalCredential({
        selector: {
          provider: "openai",
          kind: OPENAI_API_KEY_KIND,
          scope: "account",
          owner_account_id: account_id,
        },
      }),
    ]);

  const hasProjectApiKey =
    hasProjectApiKeyStored ||
    !!(project_id && projectKeys[project_id]) ||
    !!(project_id && process.env.COCALC_CODEX_AUTH_PROJECT_OPENAI_KEY);
  const hasAccountApiKey =
    hasAccountApiKeyStored ||
    !!accountKeys[account_id] ||
    !!process.env.COCALC_CODEX_AUTH_ACCOUNT_OPENAI_KEY;
  const sharedHomeMode = resolveSharedHomeMode();

  let source:
    | "subscription"
    | "project-api-key"
    | "account-api-key"
    | "site-api-key"
    | "shared-home"
    | "none";
  if (hasSubscription) {
    source = "subscription";
  } else if (hasProjectApiKey) {
    source = "project-api-key";
  } else if (hasAccountApiKey) {
    source = "account-api-key";
  } else if (hasSiteApiKey) {
    source = "site-api-key";
  } else if (sharedHomeMode === "always") {
    source = "shared-home";
  } else {
    source = "none";
  }

  return {
    source,
    hasSubscription,
    hasProjectApiKey,
    hasAccountApiKey,
    hasSiteApiKey,
    sharedHomeMode,
    project_id,
  };
}

export async function upsertBrowserSession({
  account_id,
  browser_id,
  session_name,
  url,
  spawn_marker,
  active_project_id,
  open_projects,
}: {
  account_id?: string;
  browser_id: string;
  session_name?: string;
  url?: string;
  spawn_marker?: string;
  active_project_id?: string;
  open_projects?: unknown;
}): Promise<{ browser_id: string; created_at: string; updated_at: string }> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  return upsertBrowserSessionRecord({
    account_id,
    browser_id,
    session_name,
    url,
    spawn_marker,
    active_project_id,
    open_projects,
  });
}

export async function listBrowserSessions({
  account_id,
  max_age_ms,
  include_stale,
}: {
  account_id?: string;
  max_age_ms?: number;
  include_stale?: boolean;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const live_by_browser_id = await getLiveBrowserSessionInfo(account_id);
  return listBrowserSessionsForAccount({
    account_id,
    max_age_ms,
    include_stale,
    live_by_browser_id,
  });
}

async function getLiveBrowserSessionInfo(
  account_id: string,
): Promise<Map<string, BrowserSessionLiveInfo>> {
  const out = new Map<string, BrowserSessionLiveInfo>();
  try {
    const client = conat();
    await client.waitUntilSignedIn({ timeout: 3_000 });
    const statsByNode = await sysApiMany(client, { timeout: 2_000 }).stats();
    for (const node of statsByNode ?? []) {
      for (const sockets of Object.values(node ?? {})) {
        for (const stat of Object.values(sockets ?? {})) {
          const s = stat as ConnectionStats | undefined;
          if (!s?.user || s.user.account_id !== account_id) continue;
          const browser_id = `${s.browser_id ?? ""}`.trim();
          if (!browser_id) continue;
          const prev = out.get(browser_id);
          const nextCount = (prev?.connection_count ?? 0) + 1;
          const nextActive = Math.max(
            prev?.updated_at_ms ?? 0,
            s.active ?? s.connected ?? 0,
          );
          out.set(browser_id, {
            connected: true,
            connection_count: nextCount,
            ...(nextActive > 0 ? { updated_at_ms: nextActive } : {}),
          });
        }
      }
    }
  } catch (err) {
    logger.debug(
      "listBrowserSessions: failed to read live conat stats",
      `${err}`,
    );
  }
  return out;
}

export async function removeBrowserSession({
  account_id,
  browser_id,
}: {
  account_id?: string;
  browser_id: string;
}): Promise<{ removed: boolean }> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  return {
    removed: removeBrowserSessionRecord({
      account_id,
      browser_id,
    }),
  };
}

export async function issueBrowserSignInCookie({
  account_id,
  max_age_ms,
}: {
  account_id?: string;
  max_age_ms?: number;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const cleanMaxAgeMs = Number(max_age_ms);
  const resolvedMaxAgeMs =
    Number.isFinite(cleanMaxAgeMs) && cleanMaxAgeMs > 0
      ? Math.floor(cleanMaxAgeMs)
      : DEFAULT_BROWSER_SIGN_IN_COOKIE_MAX_AGE_MS;
  const { value } = await createRememberMeCookie(
    account_id,
    Math.max(60, Math.floor(resolvedMaxAgeMs / 1000)),
  );
  return {
    account_id,
    remember_me: value,
    max_age_ms: resolvedMaxAgeMs,
  };
}

async function resolveProjectContext(opts: {
  account_id?: string;
  host_id?: string;
  project_id?: string;
}): Promise<string> {
  const project_id = `${opts.project_id ?? ""}`.trim();
  if (!project_id) {
    throw Error("project_id is required");
  }
  if (opts.account_id) {
    await assertProjectCollaborator(opts.account_id, project_id);
  }
  if (opts.host_id) {
    let assigned = "";
    try {
      assigned = (await getAssignedProjectHostInfo(project_id)).host_id;
    } catch {
      assigned = "";
    }
    if (!assigned || assigned !== opts.host_id) {
      throw Error("project is not assigned to this host");
    }
  }
  return project_id;
}

export async function getProjectAppPublicPolicy({
  account_id,
  host_id,
  project_id,
}: {
  account_id?: string;
  host_id?: string;
  project_id?: string;
}) {
  const resolvedProjectId = await resolveProjectContext({
    account_id,
    host_id,
    project_id,
  });
  return await getProjectAppPublicPolicyRaw(resolvedProjectId);
}

export async function tracePublicAppHostname({
  account_id,
  host_id,
  hostname,
}: {
  account_id?: string;
  host_id?: string;
  hostname: string;
}) {
  const normalized = `${hostname ?? ""}`.trim().toLowerCase();
  if (!normalized) {
    throw Error("hostname is required");
  }
  const target = await getPublicAppRouteByHostnameRaw(normalized);
  if (!target) {
    return {
      matched: false,
      hostname: normalized,
    };
  }
  if (!account_id && !host_id) {
    throw Error("must be signed in");
  }
  if (account_id) {
    await assertProjectCollaborator(account_id, target.project_id);
  }
  if (host_id) {
    await resolveProjectContext({ host_id, project_id: target.project_id });
  }
  const policy = await getProjectAppPublicPolicyRaw(target.project_id);
  const dnsTargetHostname = policy.host_hostname;
  const dns_target =
    dnsTargetHostname != null
      ? await resolvePublicAppDnsTarget(dnsTargetHostname)
      : undefined;
  return {
    matched: true,
    hostname: normalized,
    project_id: target.project_id,
    app_id: target.app_id,
    base_path: target.base_path,
    site_hostname: policy.site_hostname,
    host_hostname: policy.host_hostname,
    dns_domain: policy.dns_domain,
    subdomain_suffix: policy.subdomain_suffix,
    dns_target,
    metered_egress: policy.metered_egress,
    warnings: policy.warnings,
  };
}

export async function reserveProjectAppPublicSubdomain({
  account_id,
  host_id,
  project_id,
  app_id,
  base_path,
  ttl_s,
  preferred_label,
  random_subdomain,
}: {
  account_id?: string;
  host_id?: string;
  project_id?: string;
  app_id: string;
  base_path: string;
  ttl_s: number;
  preferred_label?: string;
  random_subdomain?: boolean;
}) {
  const resolvedProjectId = await resolveProjectContext({
    account_id,
    host_id,
    project_id,
  });
  return await reserveProjectAppPublicSubdomainRaw({
    project_id: resolvedProjectId,
    app_id,
    base_path,
    ttl_s,
    preferred_label,
    random_subdomain,
  });
}

export async function releaseProjectAppPublicSubdomain({
  account_id,
  host_id,
  project_id,
  app_id,
}: {
  account_id?: string;
  host_id?: string;
  project_id?: string;
  app_id: string;
}) {
  const resolvedProjectId = await resolveProjectContext({
    account_id,
    host_id,
    project_id,
  });
  return await releaseProjectAppPublicSubdomainRaw({
    project_id: resolvedProjectId,
    app_id,
  });
}

export async function getPublicSiteUrl({
  account_id,
}: {
  account_id?: string;
}): Promise<{ url: string }> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const { dns } = await getServerSettings();
  let url = `${dns ?? ""}`.trim();
  if (!url) {
    throw Error("public site URL is not configured");
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  if (basePath?.length) {
    url = `${url.replace(/\/+$/, "")}${basePath.startsWith("/") ? "" : "/"}${basePath}`;
  }
  return { url: url.replace(/\/+$/, "") };
}

function clean(v?: string): string | undefined {
  const s = `${v ?? ""}`.trim();
  return s.length > 0 ? s : undefined;
}

export async function testR2Credentials({
  account_id,
  overrides,
}: {
  account_id?: string;
  overrides?: {
    r2_account_id?: string;
    r2_api_token?: string;
    r2_access_key_id?: string;
    r2_secret_access_key?: string;
    r2_bucket_prefix?: string;
    r2_endpoint?: string;
  };
}): Promise<R2CredentialsTestResult> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  const settings = await getServerSettings();
  const accountId =
    clean(overrides?.r2_account_id) ??
    clean(settings.r2_account_id) ??
    clean(settings.project_hosts_cloudflare_tunnel_account_id);
  const endpoint =
    clean(overrides?.r2_endpoint) ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  return await testR2Credentials0({
    accountId,
    apiToken: clean(overrides?.r2_api_token) ?? clean(settings.r2_api_token),
    accessKey:
      clean(overrides?.r2_access_key_id) ?? clean(settings.r2_access_key_id),
    secretKey:
      clean(overrides?.r2_secret_access_key) ??
      clean(settings.r2_secret_access_key),
    bucketPrefix:
      clean(overrides?.r2_bucket_prefix) ?? clean(settings.r2_bucket_prefix),
    endpoint,
  });
}
