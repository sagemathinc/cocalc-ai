import getCustomize from "@cocalc/database/settings/customize";
export { getCustomize };
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
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import {
  getExternalCredential,
  hasExternalCredential,
  listExternalCredentials as listExternalCredentialsStore,
  revokeExternalCredential as revokeExternalCredentialStore,
  upsertExternalCredential,
} from "@cocalc/server/external-credentials/store";
import isCollaborator from "@cocalc/server/projects/is-collaborator";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { to_bool } from "@cocalc/util/db-schema/site-defaults";
import { is_valid_email_address } from "@cocalc/util/misc";
import { v4 as uuid } from "uuid";
import { secureRandomString } from "@cocalc/backend/misc";

const logger = getLogger("server:conat:api:system");

export function ping() {
  return { now: Date.now() };
}

export async function terminate() {}

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
  const finalPassword = explicitPassword.length > 0 ? explicitPassword : generatedPassword!;
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
  const mode = `${process.env.COCALC_CODEX_AUTH_SHARED_HOME_MODE ?? defaultMode}`
    .trim()
    .toLowerCase();
  if (mode === "disabled") return "disabled";
  if (mode === "prefer" || mode === "always") return mode;
  return "fallback";
}

const CODEX_SUBSCRIPTION_KIND = "codex-subscription-auth-json";
const OPENAI_API_KEY_KIND = "openai-api-key";

function toExternalCredentialInfo(
  credential:
    | Awaited<ReturnType<typeof getExternalCredential>>
    | undefined,
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
  if (!(await isCollaborator({ account_id, project_id }))) {
    throw Error("user must be a collaborator on project");
  }
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
