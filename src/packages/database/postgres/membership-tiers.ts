import { callback2 } from "@cocalc/util/async-utils";
import type {
  MembershipTierUsageCountRow,
  MembershipTierUsageReport,
} from "@cocalc/conat/hub/api/purchases";
import { PostgreSQL } from "./types";

function isDelete(options: { delete?: boolean }[]) {
  return options.some((v) => v?.delete === true);
}

export interface MembershipTierMutationQuery {
  id: string;
  label?: string | null;
  store_visible?: boolean | null;
  store_description?: string | null;
  store_highlights?: string[] | null;
  site_license_pool_description?: string | null;
  team_visible?: boolean | null;
  course_store_visible?: boolean | null;
  course_allowed_domains?: string[] | null;
  priority?: number | null;
  price_monthly?: number | null;
  price_yearly?: number | null;
  trial_days?: number | null;
  course_price?: number | null;
  course_duration_days?: number | null;
  course_grace_days?: number | null;
  project_defaults?;
  ai_limits?;
  features?;
  usage_limits?;
  pricing_model?;
  disabled?: boolean | null;
  notes?: string | null;
}

interface MembershipTierUpsertOptions {
  rejectExisting?: boolean;
  requireExisting?: boolean;
}

function mapStorageRow(row) {
  if (!row) return row;
  return row;
}

function buildHistoryEntry(row): Record<string, unknown> {
  if (!row) return {};
  const entry = { ...row };
  delete entry.history;
  return entry;
}

function toJsonParam(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

async function getExistingTables(
  db: PostgreSQL,
  tableNames: readonly string[],
): Promise<Set<string>> {
  const { rows } = await callback2(db._query, {
    query: `SELECT table_name
              FROM unnest($1::text[]) AS tables(table_name)
             WHERE to_regclass('public.' || table_name) IS NOT NULL`,
    params: [tableNames],
  });
  return new Set((rows ?? []).map((row) => row.table_name).filter(Boolean));
}

const LIVE_MEMBERSHIP_SUBSCRIPTION_FILTER = `metadata->>'type'='membership'
              AND status IN ('active','canceled')
              AND current_period_end >= NOW()`;

type LiveSubscriptionCounts = {
  subscription_count: number;
  subscribed_account_count: number;
};

type HistoricalTierReferenceSource = {
  table: string;
  expression: string;
  where?: string;
};

const HISTORICAL_TIER_REFERENCE_SOURCES: readonly HistoricalTierReferenceSource[] =
  [
    {
      table: "subscriptions",
      expression: "metadata->>'class'",
      where: "metadata->>'type'='membership'",
    },
    { table: "membership_packages", expression: "membership_class" },
    { table: "membership_grants", expression: "membership_class" },
    { table: "admin_assigned_memberships", expression: "membership_class" },
    { table: "team_license_seat_lines", expression: "membership_class" },
    { table: "membership_trial_claims", expression: "membership_class" },
    {
      table: "site_license_pool_requests",
      expression: "requested_membership_class",
    },
    {
      table: "site_license_external_claim_pools",
      expression: "default_membership_class",
    },
    {
      table: "site_license_external_claim_consumptions",
      expression: "membership_class",
    },
  ];

async function getHistoricalTierUsageCounts(
  db: PostgreSQL,
): Promise<Record<string, number>> {
  const existingTables = await getExistingTables(
    db,
    HISTORICAL_TIER_REFERENCE_SOURCES.map(({ table }) => table),
  );
  const references = HISTORICAL_TIER_REFERENCE_SOURCES.filter(({ table }) =>
    existingTables.has(table),
  );
  if (references.length === 0) return {};
  const referenceUnion = references
    .map(
      ({ table, expression, where }) =>
        `SELECT ${expression} AS tier_id
           FROM ${table}${where ? ` WHERE ${where}` : ""}`,
    )
    .join("\nUNION ALL\n");
  const { rows } = await callback2(db._query, {
    query: `SELECT tier_id,
                   COUNT(*)::int AS usage_history_count
              FROM (
                ${referenceUnion}
              ) usage_history
             WHERE tier_id IS NOT NULL
               AND tier_id != ''
             GROUP BY tier_id`,
  });
  return (rows ?? []).reduce(
    (acc, row) => {
      if (!row?.tier_id) return acc;
      acc[row.tier_id] = row.usage_history_count ?? 0;
      return acc;
    },
    {} as Record<string, number>,
  );
}

async function hasSiteLicenseUsageTables(db: PostgreSQL): Promise<boolean> {
  const { rows } = await callback2(db._query, {
    query: `SELECT to_regclass('public.site_licenses') IS NOT NULL
                     AND to_regclass('public.membership_packages') IS NOT NULL
                     AS exists`,
  });
  return rows?.[0]?.exists === true;
}

async function hasMembershipPackageUsageTables(
  db: PostgreSQL,
): Promise<boolean> {
  const { rows } = await callback2(db._query, {
    query: `SELECT to_regclass('public.membership_packages') IS NOT NULL
                     AND to_regclass('public.membership_package_assignments') IS NOT NULL
                     AS exists`,
  });
  return rows?.[0]?.exists === true;
}

async function getLiveSubscriptionTierCounts(
  db: PostgreSQL,
): Promise<Record<string, LiveSubscriptionCounts>> {
  const { rows } = await callback2(db._query, {
    query: `SELECT metadata->>'class' AS tier_id,
                   COUNT(*)::int AS subscription_count,
                   COUNT(DISTINCT account_id)::int AS subscribed_account_count
            FROM subscriptions
            WHERE ${LIVE_MEMBERSHIP_SUBSCRIPTION_FILTER}
            GROUP BY tier_id`,
  });
  return (rows ?? []).reduce(
    (acc, row) => {
      if (!row?.tier_id) return acc;
      acc[row.tier_id] = {
        subscription_count: row.subscription_count ?? 0,
        subscribed_account_count: row.subscribed_account_count ?? 0,
      };
      return acc;
    },
    {} as Record<string, LiveSubscriptionCounts>,
  );
}

function accountHomeBayFilterSql(
  accountAlias: string,
  bay_id?: string,
  paramIndex = 1,
): { sql: string; params: string[] } {
  const normalizedBayId = `${bay_id ?? ""}`.trim();
  if (!normalizedBayId) return { sql: "", params: [] };
  return {
    sql: `AND COALESCE(NULLIF(BTRIM(${accountAlias}.home_bay_id), ''), $${paramIndex}::TEXT) = $${paramIndex}::TEXT`,
    params: [normalizedBayId],
  };
}

async function getActiveSiteLicenseTierCounts(
  db: PostgreSQL,
): Promise<Record<string, number>> {
  if (!(await hasSiteLicenseUsageTables(db))) {
    return {};
  }
  const { rows } = await callback2(db._query, {
    query: `SELECT p.membership_class AS tier_id,
                   COUNT(DISTINCT s.id)::int AS site_license_count
            FROM membership_packages p
            JOIN site_licenses s
              ON p.metadata->>'site_license_id' = s.id::text
            WHERE p.kind = 'site'
              AND p.metadata->>'site_license_id' IS NOT NULL
              AND (s.starts_at IS NULL OR s.starts_at <= NOW())
              AND (s.expires_at IS NULL OR s.expires_at > NOW())
              AND (p.starts_at IS NULL OR p.starts_at <= NOW())
              AND (p.expires_at IS NULL OR p.expires_at > NOW())
            GROUP BY p.membership_class`,
  });
  return (rows ?? []).reduce((acc, row) => {
    if (!row?.tier_id) return acc;
    acc[row.tier_id] = row.site_license_count ?? 0;
    return acc;
  }, {});
}

async function getActiveTeamSeatTierCounts(
  db: PostgreSQL,
): Promise<Record<string, number>> {
  if (!(await hasMembershipPackageUsageTables(db))) {
    return {};
  }
  const { rows } = await callback2(db._query, {
    query: `SELECT membership_class AS tier_id,
                   SUM(seat_count)::int AS team_seat_count
            FROM membership_packages
            WHERE kind = 'team'
              AND (starts_at IS NULL OR starts_at <= NOW())
              AND (expires_at IS NULL OR expires_at > NOW())
            GROUP BY membership_class`,
  });
  return (rows ?? []).reduce((acc, row) => {
    if (!row?.tier_id) return acc;
    acc[row.tier_id] = row.team_seat_count ?? 0;
    return acc;
  }, {});
}

type PackageAccountCounts = {
  team_account_count: number;
  course_account_count: number;
  site_account_count: number;
};

async function getActivePackageAccountTierCounts(
  db: PostgreSQL,
): Promise<Record<string, PackageAccountCounts>> {
  if (!(await hasMembershipPackageUsageTables(db))) {
    return {};
  }
  const { rows } = await callback2(db._query, {
    query: `SELECT p.membership_class AS tier_id,
                   COUNT(DISTINCT CASE WHEN p.kind = 'team' THEN a.account_id END)::int AS team_account_count,
                   COUNT(DISTINCT CASE WHEN p.kind = 'course' THEN a.account_id END)::int AS course_account_count,
                   COUNT(DISTINCT CASE WHEN p.kind = 'site' THEN a.account_id END)::int AS site_account_count
            FROM membership_packages p
            JOIN membership_package_assignments a
              ON a.package_id = p.id
             AND a.revoked_at IS NULL
             AND a.account_id IS NOT NULL
            WHERE p.kind IN ('team', 'course', 'site')
              AND (p.starts_at IS NULL OR p.starts_at <= NOW())
              AND (p.expires_at IS NULL OR p.expires_at > NOW())
            GROUP BY p.membership_class`,
  });
  return (rows ?? []).reduce((acc, row) => {
    if (!row?.tier_id) return acc;
    acc[row.tier_id] = {
      team_account_count: row.team_account_count ?? 0,
      course_account_count: row.course_account_count ?? 0,
      site_account_count: row.site_account_count ?? 0,
    };
    return acc;
  }, {});
}

async function getActiveAdminAssignedTierCounts(
  db: PostgreSQL,
  bay_id?: string,
): Promise<Record<string, number>> {
  const homeBayFilter = accountHomeBayFilterSql("a", bay_id);
  const { rows } = await callback2(db._query, {
    query: `SELECT tier_id,
                   COUNT(DISTINCT account_id)::int AS admin_assigned_count
              FROM (
                SELECT m.membership_class AS tier_id,
                       m.account_id
                  FROM admin_assigned_memberships m
                  LEFT JOIN accounts a
                    ON a.account_id = m.account_id
                 WHERE m.account_id IS NOT NULL
                   AND (m.expires_at IS NULL OR m.expires_at > NOW())
                   ${homeBayFilter.sql}
                UNION ALL
                SELECT 'admin' AS tier_id,
                       a.account_id
                  FROM accounts a
                  JOIN membership_tiers t
                    ON t.id = 'admin'
                   AND coalesce(t.disabled,false)=false
                 WHERE 'admin' = ANY(a.groups)
                   AND coalesce(a.deleted,false)=false
                   ${homeBayFilter.sql}
              ) admin_sources
             WHERE tier_id IS NOT NULL
               AND tier_id != ''
             GROUP BY tier_id`,
    params: homeBayFilter.params.length ? homeBayFilter.params : undefined,
  });
  return (rows ?? []).reduce((acc, row) => {
    if (!row?.tier_id) return acc;
    acc[row.tier_id] = row.admin_assigned_count ?? 0;
    return acc;
  }, {});
}

async function getTotalAccountTierCounts(
  db: PostgreSQL,
  bay_id?: string,
): Promise<Record<string, number>> {
  const homeBayFilter = accountHomeBayFilterSql("a", bay_id);
  const includePackageAccounts = await hasMembershipPackageUsageTables(db);
  const packageAccountUnion = includePackageAccounts
    ? `UNION ALL
       SELECT p.membership_class AS tier_id,
              a.account_id
         FROM membership_packages p
         JOIN membership_package_assignments a
           ON a.package_id = p.id
          AND a.revoked_at IS NULL
          AND a.account_id IS NOT NULL
        WHERE p.kind IN ('team', 'course', 'site')
          AND (p.starts_at IS NULL OR p.starts_at <= NOW())
          AND (p.expires_at IS NULL OR p.expires_at > NOW())`
    : "";
  const adminGroupAccountUnion = `UNION ALL
                SELECT 'admin' AS tier_id,
                       a.account_id
                  FROM accounts a
                  JOIN membership_tiers t
                    ON t.id = 'admin'
                   AND coalesce(t.disabled,false)=false
                 WHERE 'admin' = ANY(a.groups)
                   AND coalesce(a.deleted,false)=false
                   ${homeBayFilter.sql}`;
  const { rows } = await callback2(db._query, {
    query: `SELECT tier_id,
                   COUNT(DISTINCT account_id)::int AS total_account_count
              FROM (
                SELECT metadata->>'class' AS tier_id,
                       account_id
                  FROM subscriptions
                 WHERE ${LIVE_MEMBERSHIP_SUBSCRIPTION_FILTER}
                   AND account_id IS NOT NULL
                UNION ALL
                SELECT m.membership_class AS tier_id,
                       m.account_id
                  FROM admin_assigned_memberships m
                  LEFT JOIN accounts a
                    ON a.account_id = m.account_id
                 WHERE m.account_id IS NOT NULL
                   AND (m.expires_at IS NULL OR m.expires_at > NOW())
                   ${homeBayFilter.sql}
                ${packageAccountUnion}
                ${adminGroupAccountUnion}
              ) accounts
             WHERE tier_id IS NOT NULL
               AND tier_id != ''
             GROUP BY tier_id`,
    params: homeBayFilter.params.length ? homeBayFilter.params : undefined,
  });
  return (rows ?? []).reduce((acc, row) => {
    if (!row?.tier_id) return acc;
    acc[row.tier_id] = row.total_account_count ?? 0;
    return acc;
  }, {});
}

async function getTotalActiveAccountCount(
  db: PostgreSQL,
  bay_id?: string,
): Promise<number> {
  const normalizedBayId = `${bay_id ?? ""}`.trim();
  const homeBayFilter = normalizedBayId
    ? `AND COALESCE(NULLIF(BTRIM(home_bay_id), ''), $1::TEXT) = $1::TEXT`
    : "";
  const { rows } = await callback2(db._query, {
    query: `SELECT COUNT(*)::int AS total_active_account_count
              FROM accounts
             WHERE coalesce(deleted,false)=false
               ${homeBayFilter}`,
    params: normalizedBayId ? [normalizedBayId] : undefined,
  });
  return rows?.[0]?.total_active_account_count ?? 0;
}

function ensureUsageCountRow(
  rows: Map<string, MembershipTierUsageCountRow>,
  tier_id: string,
): MembershipTierUsageCountRow {
  const existing = rows.get(tier_id);
  if (existing != null) return existing;
  const row: MembershipTierUsageCountRow = {
    tier_id,
    subscription_count: 0,
    subscribed_account_count: 0,
    team_seat_count: 0,
    team_account_count: 0,
    course_account_count: 0,
    site_account_count: 0,
    admin_assigned_count: 0,
    site_license_count: 0,
    total_account_count: 0,
    usage_history_count: 0,
  };
  rows.set(tier_id, row);
  return row;
}

export async function getMembershipTierUsageReport(
  db: PostgreSQL,
  bay_id: string,
): Promise<MembershipTierUsageReport> {
  const [
    usageHistoryByTier,
    subscriptionByTier,
    siteLicenseByTier,
    adminAssignedByTier,
    teamSeatsByTier,
    packageAccountsByTier,
    totalAccountsByTier,
    totalActiveAccountCount,
  ] = await Promise.all([
    getHistoricalTierUsageCounts(db),
    getLiveSubscriptionTierCounts(db),
    getActiveSiteLicenseTierCounts(db),
    getActiveAdminAssignedTierCounts(db, bay_id),
    getActiveTeamSeatTierCounts(db),
    getActivePackageAccountTierCounts(db),
    getTotalAccountTierCounts(db, bay_id),
    getTotalActiveAccountCount(db, bay_id),
  ]);
  const rows = new Map<string, MembershipTierUsageCountRow>();
  for (const [tier_id, usage_history_count] of Object.entries(
    usageHistoryByTier,
  )) {
    ensureUsageCountRow(rows, tier_id).usage_history_count =
      usage_history_count ?? 0;
  }
  for (const [tier_id, counts] of Object.entries(subscriptionByTier)) {
    const row = ensureUsageCountRow(rows, tier_id);
    row.subscription_count = counts.subscription_count ?? 0;
    row.subscribed_account_count = counts.subscribed_account_count ?? 0;
  }
  for (const [tier_id, site_license_count] of Object.entries(
    siteLicenseByTier,
  )) {
    ensureUsageCountRow(rows, tier_id).site_license_count =
      site_license_count ?? 0;
  }
  for (const [tier_id, admin_assigned_count] of Object.entries(
    adminAssignedByTier,
  )) {
    ensureUsageCountRow(rows, tier_id).admin_assigned_count =
      admin_assigned_count ?? 0;
  }
  for (const [tier_id, team_seat_count] of Object.entries(teamSeatsByTier)) {
    ensureUsageCountRow(rows, tier_id).team_seat_count = team_seat_count ?? 0;
  }
  for (const [tier_id, counts] of Object.entries(packageAccountsByTier)) {
    const row = ensureUsageCountRow(rows, tier_id);
    row.team_account_count = counts.team_account_count ?? 0;
    row.course_account_count = counts.course_account_count ?? 0;
    row.site_account_count = counts.site_account_count ?? 0;
  }
  for (const [tier_id, total_account_count] of Object.entries(
    totalAccountsByTier,
  )) {
    ensureUsageCountRow(rows, tier_id).total_account_count =
      total_account_count ?? 0;
  }
  return {
    bay_id,
    total_active_account_count: totalActiveAccountCount,
    tiers: [...rows.values()].sort((a, b) =>
      a.tier_id.localeCompare(b.tier_id),
    ),
  };
}

async function assertTierNotUsedByActiveMembershipUsage(
  db: PostgreSQL,
  tier_id: string,
): Promise<void> {
  const [
    subscriptionByTier,
    siteLicenseByTier,
    adminAssignedByTier,
    teamSeatsByTier,
    packageAccountsByTier,
  ] = await Promise.all([
    getLiveSubscriptionTierCounts(db),
    getActiveSiteLicenseTierCounts(db),
    getActiveAdminAssignedTierCounts(db),
    getActiveTeamSeatTierCounts(db),
    getActivePackageAccountTierCounts(db),
  ]);
  const subscriptionCount =
    subscriptionByTier[tier_id]?.subscription_count ?? 0;
  const siteLicenseCount = siteLicenseByTier[tier_id] ?? 0;
  const adminAssignedCount = adminAssignedByTier[tier_id] ?? 0;
  const teamSeatCount = teamSeatsByTier[tier_id] ?? 0;
  const packageAccounts = packageAccountsByTier[tier_id];
  const teamAccountCount = packageAccounts?.team_account_count ?? 0;
  const courseAccountCount = packageAccounts?.course_account_count ?? 0;
  const siteAccountCount = packageAccounts?.site_account_count ?? 0;

  const usage: string[] = [];
  if (subscriptionCount > 0) {
    usage.push(
      `${subscriptionCount} live personal subscription${
        subscriptionCount === 1 ? "" : "s"
      }`,
    );
  }
  if (teamSeatCount > 0) {
    usage.push(
      `${teamSeatCount} active team seat${teamSeatCount === 1 ? "" : "s"}`,
    );
  }
  if (teamAccountCount > 0) {
    usage.push(
      `${teamAccountCount} active team account${
        teamAccountCount === 1 ? "" : "s"
      }`,
    );
  }
  if (courseAccountCount > 0) {
    usage.push(
      `${courseAccountCount} active course account${
        courseAccountCount === 1 ? "" : "s"
      }`,
    );
  }
  if (siteLicenseCount > 0) {
    usage.push(
      `${siteLicenseCount} active site license${
        siteLicenseCount === 1 ? "" : "s"
      }`,
    );
  }
  if (siteAccountCount > 0) {
    usage.push(
      `${siteAccountCount} active site-license account${
        siteAccountCount === 1 ? "" : "s"
      }`,
    );
  }
  if (adminAssignedCount > 0) {
    usage.push(
      `${adminAssignedCount} active admin assignment${
        adminAssignedCount === 1 ? "" : "s"
      }`,
    );
  }

  if (usage.length > 0) {
    throw Error(
      `cannot delete membership tier "${tier_id}" because it is used by ${usage.join(
        ", ",
      )}`,
    );
  }
}

async function assertTierHasNoUsageHistory(
  db: PostgreSQL,
  tier_id: string,
): Promise<void> {
  const usageHistoryByTier = await getHistoricalTierUsageCounts(db);
  if ((usageHistoryByTier[tier_id] ?? 0) > 0) {
    throw Error(
      `cannot delete membership tier "${tier_id}" because it has usage history`,
    );
  }
}

export async function deleteMembershipTier(
  db: PostgreSQL,
  tier_id: string,
): Promise<void> {
  await assertTierHasNoUsageHistory(db, tier_id);
  await assertTierNotUsedByActiveMembershipUsage(db, tier_id);
  await callback2(db._query, {
    query: "DELETE FROM membership_tiers WHERE id = $1",
    params: [tier_id],
  });
}

export async function upsertMembershipTier(
  db: PostgreSQL,
  query: MembershipTierMutationQuery,
  {
    rejectExisting = false,
    requireExisting = false,
  }: MembershipTierUpsertOptions = {},
): Promise<unknown> {
  const {
    id,
    label,
    store_visible,
    store_description,
    store_highlights,
    site_license_pool_description,
    team_visible,
    course_store_visible,
    course_allowed_domains,
    priority,
    price_monthly,
    price_yearly,
    trial_days,
    course_price,
    course_duration_days,
    course_grace_days,
    project_defaults,
    ai_limits,
    features,
    usage_limits,
    pricing_model,
    disabled,
    notes,
  } = query;

  const existing = await callback2(db._query, {
    query: "SELECT * FROM membership_tiers WHERE id = $1",
    params: [id],
  });
  const previous = existing.rows?.[0];
  if (rejectExisting && previous != null) {
    throw Error(`membership tier "${id}" already exists`);
  }
  if (requireExisting && previous == null) {
    throw Error(`membership tier "${id}" does not exist`);
  }
  const history = Array.isArray(previous?.history) ? previous.history : [];
  const nextHistory =
    previous == null ? history : [...history, buildHistoryEntry(previous)];

  const { rows } = await callback2(db._query, {
    query: `INSERT INTO membership_tiers (
                "id",
                "label",
                "store_visible",
                "store_description",
                "store_highlights",
                "site_license_pool_description",
                "team_visible",
                "course_store_visible",
                "course_allowed_domains",
                "priority",
                "price_monthly",
                "price_yearly",
                "trial_days",
                "course_price",
                "course_duration_days",
                "course_grace_days",
                "project_defaults",
                "ai_limits",
                "features",
                "usage_limits",
                "pricing_model",
                "disabled",
                "notes",
                "history",
                "created",
                "updated"
              )
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::JSONB,$18::JSONB,$19::JSONB,$20::JSONB,$21::JSONB,$22,$23,$24::JSONB,NOW(),NOW())
              ON CONFLICT (id)
              DO UPDATE SET
                "label" = EXCLUDED.label,
                "store_visible" = EXCLUDED.store_visible,
                "store_description" = EXCLUDED.store_description,
                "store_highlights" = EXCLUDED.store_highlights,
                "site_license_pool_description" = EXCLUDED.site_license_pool_description,
                "team_visible" = EXCLUDED.team_visible,
                "course_store_visible" = EXCLUDED.course_store_visible,
                "course_allowed_domains" = EXCLUDED.course_allowed_domains,
                "priority" = EXCLUDED.priority,
                "price_monthly" = EXCLUDED.price_monthly,
                "price_yearly" = EXCLUDED.price_yearly,
                "trial_days" = EXCLUDED.trial_days,
                "course_price" = EXCLUDED.course_price,
                "course_duration_days" = EXCLUDED.course_duration_days,
                "course_grace_days" = EXCLUDED.course_grace_days,
                "project_defaults" = EXCLUDED.project_defaults,
                "ai_limits" = EXCLUDED.ai_limits,
                "features" = EXCLUDED.features,
                "usage_limits" = EXCLUDED.usage_limits,
                "pricing_model" = EXCLUDED.pricing_model,
                "disabled" = EXCLUDED.disabled,
                "notes" = EXCLUDED.notes,
                "history" = EXCLUDED.history,
                "updated" = NOW()`,
    params: [
      id,
      label ?? null,
      store_visible ?? false,
      store_description ?? null,
      store_highlights ?? null,
      site_license_pool_description ?? null,
      team_visible ?? false,
      course_store_visible ?? false,
      course_allowed_domains ?? null,
      priority ?? 0,
      price_monthly ?? null,
      price_yearly ?? null,
      trial_days ?? null,
      course_price ?? null,
      course_duration_days ?? null,
      course_grace_days ?? null,
      toJsonParam(project_defaults),
      toJsonParam(ai_limits),
      toJsonParam(features),
      toJsonParam(usage_limits),
      toJsonParam(pricing_model),
      disabled ?? false,
      notes ?? null,
      toJsonParam(nextHistory ?? []),
    ],
  });
  return rows;
}

export async function getMembershipTierRows(db: PostgreSQL): Promise<any[]> {
  const { rows } = await callback2(db._query, {
    query: "SELECT * FROM membership_tiers",
  });
  return rows.map(mapStorageRow);
}

export default async function membershipTiersQuery(
  db: PostgreSQL,
  options: { delete?: boolean }[],
  query: MembershipTierMutationQuery,
) {
  if (isDelete(options) && query.id) {
    await deleteMembershipTier(db, query.id);
    return;
  }

  if (query.id == "*") {
    const rows = await getMembershipTierRows(db);
    const usageHistoryByTier = await getHistoricalTierUsageCounts(db);
    const subscriptionByTier = await getLiveSubscriptionTierCounts(db);
    const siteLicenseByTier = await getActiveSiteLicenseTierCounts(db);
    const adminAssignedByTier = await getActiveAdminAssignedTierCounts(db);
    const teamSeatsByTier = await getActiveTeamSeatTierCounts(db);
    const packageAccountsByTier = await getActivePackageAccountTierCounts(db);
    const totalAccountsByTier = await getTotalAccountTierCounts(db);
    const totalActiveAccountCount = await getTotalActiveAccountCount(db);
    return rows.map((row) => ({
      ...mapStorageRow(row),
      ...(subscriptionByTier[row.id] ?? {
        subscription_count: 0,
        subscribed_account_count: 0,
      }),
      team_seat_count: teamSeatsByTier[row.id] ?? 0,
      ...(packageAccountsByTier[row.id] ?? {
        team_account_count: 0,
        course_account_count: 0,
        site_account_count: 0,
      }),
      has_usage_history: (usageHistoryByTier[row.id] ?? 0) > 0,
      admin_assigned_count: adminAssignedByTier[row.id] ?? 0,
      site_license_count: siteLicenseByTier[row.id] ?? 0,
      total_account_count: totalAccountsByTier[row.id] ?? 0,
      total_active_account_count: totalActiveAccountCount,
    }));
  } else if (query.id) {
    return await upsertMembershipTier(db, query);
  } else {
    throw new Error("don't know what to do with this query");
  }
}
