import getCustomize from "@cocalc/database/settings/customize";
export { getCustomize };
import { record_user_tracking } from "@cocalc/database/postgres/account/user-tracking";
import { db } from "@cocalc/database";
import manageApiKeys from "@cocalc/server/api/manage";
export { manageApiKeys };
import { type UserSearchResult } from "@cocalc/util/db-schema/accounts";
import isAdmin from "@cocalc/server/accounts/is-admin";
import search from "@cocalc/server/accounts/search";
export { getNames } from "@cocalc/server/accounts/get-name";
import { callback2 } from "@cocalc/util/async-utils";
import getLogger from "@cocalc/backend/logger";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import {
  hasExternalCredential,
  listExternalCredentials as listExternalCredentialsStore,
  revokeExternalCredential as revokeExternalCredentialStore,
} from "@cocalc/server/external-credentials/store";

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

function resolveSharedHomeMode(): "fallback" | "prefer" | "always" {
  const mode = `${process.env.COCALC_CODEX_AUTH_SHARED_HOME_MODE ?? "fallback"}`
    .trim()
    .toLowerCase();
  if (mode === "prefer" || mode === "always") return mode;
  return "fallback";
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
  const hasProjectApiKey =
    !!(project_id && projectKeys[project_id]) ||
    !!(project_id && process.env.COCALC_CODEX_AUTH_PROJECT_OPENAI_KEY);
  const hasAccountApiKey =
    !!accountKeys[account_id] || !!process.env.COCALC_CODEX_AUTH_ACCOUNT_OPENAI_KEY;
  const hasSiteApiKey = !!process.env.COCALC_CODEX_AUTH_SITE_OPENAI_KEY;
  const hasSubscription = await hasExternalCredential({
    selector: {
      provider: "openai",
      kind: "codex-subscription-auth-json",
      scope: "account",
      owner_account_id: account_id,
    },
  });
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
