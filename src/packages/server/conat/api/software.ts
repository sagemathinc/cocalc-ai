import getPool from "@cocalc/database/pool";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { uuid } from "@cocalc/util/misc";
import {
  encodeSoftwareLicenseToken,
  signSoftwareLicense,
  type SoftwareLicensePayload,
} from "@cocalc/util/software-licenses/token";
import getLogger from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { requireDangerousSessionAuth } from "./dangerous-session-auth";

const logger = getLogger("server:conat:api:software");
const PRIVATE_KEY_SETTING = "software_license_private_key";
const ADMIN_LICENSE_LIST_COLUMNS =
  "id, tier_id, owner_account_id, created, expires_at, revoked_at, limits, features, notes, created_by, last_refresh_at";

function isSeedBay(): boolean {
  return getConfiguredBayId() === getConfiguredClusterSeedBayId();
}

function getSeedSoftwareLicenseClient() {
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: getConfiguredClusterSeedBayId(),
  });
}

function requireAdmin(account_id?: string) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  return isAdmin(account_id);
}

async function requireAdminDangerousAuth({
  account_id,
  browser_id,
  session_hash,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
}) {
  if (!(await requireAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
}

async function getPrivateKey(): Promise<string> {
  const settings = await getServerSettings();
  const key = settings?.[PRIVATE_KEY_SETTING];
  if (!key) {
    throw Error(`missing server setting ${PRIVATE_KEY_SETTING}`);
  }
  return key;
}

async function recordEvent({
  license_id,
  event,
  actor_account_id,
  metadata,
}: {
  license_id: string;
  event: string;
  actor_account_id?: string;
  metadata?: Record<string, any>;
}) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO software_license_events
      (id, license_id, ts, event, metadata, actor_account_id)
      VALUES ($1, $2, NOW(), $3, $4, $5)`,
    [uuid(), license_id, event, metadata ?? null, actor_account_id ?? null],
  );
}

export async function listLicenseTiersOnSeed({
  include_disabled,
}: {
  include_disabled?: boolean;
}) {
  const pool = getPool();
  const where = include_disabled ? "" : "WHERE coalesce(disabled,false)=false";
  const { rows } = await pool.query(
    `SELECT * FROM software_license_tiers ${where} ORDER BY id ASC`,
  );
  return rows;
}

export async function listLicenseTiers({
  account_id,
  include_disabled,
}: {
  account_id?: string;
  include_disabled?: boolean;
}) {
  if (!(await requireAdmin(account_id))) {
    throw Error("must be an admin");
  }
  if (!isSeedBay()) {
    return await getSeedSoftwareLicenseClient().listSoftwareLicenseTiers({
      actor_account_id: account_id!,
      include_disabled,
    });
  }
  return await listLicenseTiersOnSeed({ include_disabled });
}

export async function upsertLicenseTierOnSeed({
  tier,
  actor_account_id,
}: {
  actor_account_id?: string;
  tier: {
    id: string;
    label?: string;
    description?: string;
    max_accounts?: number;
    max_project_hosts?: number;
    max_active_licenses?: number;
    defaults?: Record<string, any>;
    features?: Record<string, any>;
    disabled?: boolean;
    notes?: string;
  };
}) {
  if (!tier?.id) {
    throw Error("tier.id must be set");
  }
  const pool = getPool();
  await pool.query(
    `INSERT INTO software_license_tiers
      (id, label, description, max_accounts, max_project_hosts, max_active_licenses,
       defaults, features, disabled, notes, created, updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET
       label=EXCLUDED.label,
       description=EXCLUDED.description,
       max_accounts=EXCLUDED.max_accounts,
       max_project_hosts=EXCLUDED.max_project_hosts,
       max_active_licenses=EXCLUDED.max_active_licenses,
       defaults=EXCLUDED.defaults,
       features=EXCLUDED.features,
       disabled=EXCLUDED.disabled,
       notes=EXCLUDED.notes,
       updated=NOW()`,
    [
      tier.id,
      tier.label ?? null,
      tier.description ?? null,
      tier.max_accounts ?? null,
      tier.max_project_hosts ?? null,
      tier.max_active_licenses ?? null,
      tier.defaults ?? null,
      tier.features ?? null,
      tier.disabled ?? null,
      tier.notes ?? null,
    ],
  );
  logger.info("upserted software license tier", {
    tier_id: tier.id,
    actor_account_id,
  });
}

export async function upsertLicenseTier({
  account_id,
  browser_id,
  session_hash,
  tier,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  tier: {
    id: string;
    label?: string;
    description?: string;
    max_accounts?: number;
    max_project_hosts?: number;
    max_active_licenses?: number;
    defaults?: Record<string, any>;
    features?: Record<string, any>;
    disabled?: boolean;
    notes?: string;
  };
}) {
  await requireAdminDangerousAuth({ account_id, browser_id, session_hash });
  if (!isSeedBay()) {
    return await getSeedSoftwareLicenseClient().upsertSoftwareLicenseTier({
      actor_account_id: account_id!,
      tier,
    });
  }
  return await upsertLicenseTierOnSeed({ tier, actor_account_id: account_id });
}

export async function listLicensesOnSeed({
  search,
  limit,
}: {
  search?: string;
  limit?: number;
}) {
  const pool = getPool();
  const clauses: string[] = [];
  const params: any[] = [];
  if (search) {
    params.push(`%${search}%`);
    clauses.push(
      `(id::text ILIKE $${params.length} OR owner_account_id::text ILIKE $${params.length})`,
    );
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const cap = Math.min(Math.max(limit ?? 200, 1), 1000);
  const { rows } = await pool.query(
    `SELECT ${ADMIN_LICENSE_LIST_COLUMNS} FROM software_licenses ${where} ORDER BY created DESC LIMIT ${cap}`,
    params,
  );
  return rows;
}

export async function listLicenses({
  account_id,
  search,
  limit,
}: {
  account_id?: string;
  search?: string;
  limit?: number;
}) {
  if (!(await requireAdmin(account_id))) {
    throw Error("must be an admin");
  }
  if (!isSeedBay()) {
    return await getSeedSoftwareLicenseClient().listSoftwareLicenses({
      actor_account_id: account_id!,
      search,
      limit,
    });
  }
  return await listLicensesOnSeed({ search, limit });
}

export async function createLicenseOnSeed({
  actor_account_id,
  tier_id,
  owner_account_id,
  product = "launchpad",
  expires_at,
  limits,
  features,
  notes,
}: {
  actor_account_id?: string;
  tier_id: string;
  owner_account_id?: string;
  product?: "launchpad" | "rocket";
  expires_at?: string;
  limits?: Record<string, any>;
  features?: Record<string, any>;
  notes?: string;
}) {
  const pool = getPool();
  const { rows: tiers } = await pool.query(
    "SELECT * FROM software_license_tiers WHERE id=$1",
    [tier_id],
  );
  if (tiers.length === 0) {
    throw Error(`unknown tier '${tier_id}'`);
  }
  const tier = tiers[0];
  const license_id = uuid();
  const now = new Date();
  let expiresAtIso: string | undefined = expires_at;
  if (!expiresAtIso && tier?.defaults?.expires_days) {
    const d = new Date(now);
    d.setDate(d.getDate() + Number(tier.defaults.expires_days));
    expiresAtIso = d.toISOString();
  }
  const mergedLimits = {
    max_accounts: tier.max_accounts ?? undefined,
    max_project_hosts: tier.max_project_hosts ?? undefined,
    ...(limits ?? {}),
  };
  const mergedFeatures = {
    ...(tier.features ?? {}),
    ...(features ?? {}),
  };
  const payload: SoftwareLicensePayload = {
    product,
    license_id,
    issued_at: now.toISOString(),
    valid_from: now.toISOString(),
    expires_at: expiresAtIso,
    refresh_interval_hours: tier?.defaults?.refresh_interval_hours,
    grace_days: tier?.defaults?.grace_days,
    require_online_refresh: tier?.defaults?.require_online_refresh,
    limits: mergedLimits,
    features: mergedFeatures,
    instance_binding: tier?.defaults?.instance_binding ?? "none",
  };
  const token = encodeSoftwareLicenseToken(
    signSoftwareLicense(payload, await getPrivateKey()),
  );
  const owner = owner_account_id ?? actor_account_id;
  await pool.query(
    `INSERT INTO software_licenses
      (id, tier_id, owner_account_id, created, expires_at, revoked_at,
       token, limits, features, notes, created_by)
     VALUES ($1,$2,$3,NOW(),$4,NULL,$5,$6,$7,$8,$9)`,
    [
      license_id,
      tier_id,
      owner ?? null,
      expiresAtIso ? new Date(expiresAtIso) : null,
      token,
      mergedLimits,
      mergedFeatures,
      notes ?? null,
      actor_account_id ?? null,
    ],
  );
  await recordEvent({
    license_id,
    event: "created",
    actor_account_id,
    metadata: { tier_id, owner_account_id: owner },
  });
  const { rows } = await pool.query(
    "SELECT * FROM software_licenses WHERE id=$1",
    [license_id],
  );
  logger.info("created software license", { license_id, tier_id, owner });
  return rows[0];
}

export async function createLicense({
  account_id,
  browser_id,
  session_hash,
  tier_id,
  owner_account_id,
  product = "launchpad",
  expires_at,
  limits,
  features,
  notes,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  tier_id: string;
  owner_account_id?: string;
  product?: "launchpad" | "rocket";
  expires_at?: string;
  limits?: Record<string, any>;
  features?: Record<string, any>;
  notes?: string;
}) {
  await requireAdminDangerousAuth({ account_id, browser_id, session_hash });
  if (!isSeedBay()) {
    return await getSeedSoftwareLicenseClient().createSoftwareLicense({
      actor_account_id: account_id!,
      tier_id,
      owner_account_id,
      product,
      expires_at,
      limits,
      features,
      notes,
    });
  }
  return await createLicenseOnSeed({
    actor_account_id: account_id,
    tier_id,
    owner_account_id,
    product,
    expires_at,
    limits,
    features,
    notes,
  });
}

export async function revokeLicenseOnSeed({
  actor_account_id,
  license_id,
  reason,
}: {
  actor_account_id?: string;
  license_id: string;
  reason?: string;
}) {
  const pool = getPool();
  await pool.query(
    "UPDATE software_licenses SET revoked_at=NOW() WHERE id=$1",
    [license_id],
  );
  await recordEvent({
    license_id,
    event: "revoked",
    actor_account_id,
    metadata: { reason },
  });
}

export async function revokeLicense({
  account_id,
  browser_id,
  session_hash,
  license_id,
  reason,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  license_id: string;
  reason?: string;
}) {
  await requireAdminDangerousAuth({ account_id, browser_id, session_hash });
  if (!isSeedBay()) {
    return await getSeedSoftwareLicenseClient().revokeSoftwareLicense({
      actor_account_id: account_id!,
      license_id,
      reason,
    });
  }
  return await revokeLicenseOnSeed({
    actor_account_id: account_id,
    license_id,
    reason,
  });
}

export async function restoreLicenseOnSeed({
  actor_account_id,
  license_id,
}: {
  actor_account_id?: string;
  license_id: string;
}) {
  const pool = getPool();
  await pool.query("UPDATE software_licenses SET revoked_at=NULL WHERE id=$1", [
    license_id,
  ]);
  await recordEvent({
    license_id,
    event: "restored",
    actor_account_id,
  });
}

export async function restoreLicense({
  account_id,
  browser_id,
  session_hash,
  license_id,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  license_id: string;
}) {
  await requireAdminDangerousAuth({ account_id, browser_id, session_hash });
  if (!isSeedBay()) {
    return await getSeedSoftwareLicenseClient().restoreSoftwareLicense({
      actor_account_id: account_id!,
      license_id,
    });
  }
  return await restoreLicenseOnSeed({
    actor_account_id: account_id,
    license_id,
  });
}

export async function listOwnedLicensesOnSeed({
  account_id,
}: {
  account_id: string;
}) {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT * FROM software_licenses WHERE owner_account_id=$1 ORDER BY created DESC",
    [account_id],
  );
  return rows;
}

export async function listMyLicenses({ account_id }: { account_id?: string }) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  if (!isSeedBay()) {
    return await getSeedSoftwareLicenseClient().listOwnedSoftwareLicenses({
      account_id,
    });
  }
  return await listOwnedLicensesOnSeed({ account_id });
}
