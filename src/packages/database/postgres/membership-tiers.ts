import { callback2 } from "@cocalc/util/async-utils";
import { PostgreSQL } from "./types";

function isDelete(options: { delete?: boolean }[]) {
  return options.some((v) => v?.delete === true);
}

interface Query {
  id: string;
  label?: string;
  store_visible?: boolean;
  store_description?: string | null;
  store_highlights?: string[] | null;
  site_license_pool_description?: string | null;
  team_visible?: boolean;
  course_store_visible?: boolean;
  course_allowed_domains?: string[] | null;
  priority?: number;
  price_monthly?: number;
  price_yearly?: number;
  trial_days?: number;
  course_price?: number;
  course_duration_days?: number;
  course_grace_days?: number;
  project_defaults?;
  ai_limits?;
  features?;
  usage_limits?;
  pricing_model?;
  disabled?: boolean;
  notes?: string;
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

async function hasSiteLicenseUsageTables(db: PostgreSQL): Promise<boolean> {
  const { rows } = await callback2(db._query, {
    query: `SELECT to_regclass('public.site_licenses') IS NOT NULL
                     AND to_regclass('public.membership_packages') IS NOT NULL
                     AS exists`,
  });
  return rows?.[0]?.exists === true;
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

async function getActiveAdminAssignedTierCounts(
  db: PostgreSQL,
): Promise<Record<string, number>> {
  const { rows } = await callback2(db._query, {
    query: `SELECT membership_class AS tier_id,
                   COUNT(*)::int AS admin_assigned_count
            FROM admin_assigned_memberships
            WHERE expires_at IS NULL OR expires_at > NOW()
            GROUP BY membership_class`,
  });
  return (rows ?? []).reduce((acc, row) => {
    if (!row?.tier_id) return acc;
    acc[row.tier_id] = row.admin_assigned_count ?? 0;
    return acc;
  }, {});
}

async function assertTierNotUsedByActiveSiteLicenses(
  db: PostgreSQL,
  tier_id: string,
): Promise<void> {
  const siteLicenseCount =
    (await getActiveSiteLicenseTierCounts(db))[tier_id] ?? 0;
  if (siteLicenseCount > 0) {
    throw Error(
      `cannot delete membership tier "${tier_id}" because it is used by ${siteLicenseCount} active site license${
        siteLicenseCount === 1 ? "" : "s"
      }`,
    );
  }
}

export default async function membershipTiersQuery(
  db: PostgreSQL,
  options: { delete?: boolean }[],
  query: Query,
) {
  if (isDelete(options) && query.id) {
    await assertTierNotUsedByActiveSiteLicenses(db, query.id);
    await callback2(db._query, {
      query: "DELETE FROM membership_tiers WHERE id = $1",
      params: [query.id],
    });
    return;
  }

  if (query.id == "*") {
    const { rows } = await callback2(db._query, {
      query: "SELECT * FROM membership_tiers",
    });
    const counts = await callback2(db._query, {
      query: `SELECT metadata->>'class' AS tier_id,
                     COUNT(*)::int AS subscription_count,
                     COUNT(DISTINCT account_id)::int AS account_count
              FROM subscriptions
              WHERE metadata->>'type'='membership'
              GROUP BY tier_id`,
    });
    const byTier = (counts.rows ?? []).reduce((acc, row) => {
      if (!row?.tier_id) return acc;
      acc[row.tier_id] = {
        subscription_count: row.subscription_count ?? 0,
        subscribed_account_count: row.account_count ?? 0,
      };
      return acc;
    }, {});
    const siteLicenseByTier = await getActiveSiteLicenseTierCounts(db);
    const adminAssignedByTier = await getActiveAdminAssignedTierCounts(db);
    return rows.map((row) => ({
      ...mapStorageRow(row),
      ...(byTier[row.id] ?? {
        subscription_count: 0,
        subscribed_account_count: 0,
      }),
      admin_assigned_count: adminAssignedByTier[row.id] ?? 0,
      site_license_count: siteLicenseByTier[row.id] ?? 0,
    }));
  } else if (query.id) {
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
  } else {
    throw new Error("don't know what to do with this query");
  }
}
