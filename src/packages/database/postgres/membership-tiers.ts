import { callback2 } from "@cocalc/util/async-utils";
import { PostgreSQL } from "./types";

function isDelete(options: { delete?: boolean }[]) {
  return options.some((v) => v?.delete === true);
}

interface Query {
  id: string;
  label?: string;
  store_visible?: boolean;
  course_store_visible?: boolean;
  priority?: number;
  price_monthly?: number;
  price_yearly?: number;
  course_price?: number;
  course_duration_days?: number;
  project_defaults?;
  ai_limits?;
  features?;
  usage_limits?;
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

export default async function membershipTiersQuery(
  db: PostgreSQL,
  options: { delete?: boolean }[],
  query: Query,
) {
  if (isDelete(options) && query.id) {
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
        account_count: row.account_count ?? 0,
      };
      return acc;
    }, {});
    return rows.map((row) => ({
      ...mapStorageRow(row),
      ...(byTier[row.id] ?? { subscription_count: 0, account_count: 0 }),
    }));
  } else if (query.id) {
    const {
      id,
      label,
      store_visible,
      course_store_visible,
      priority,
      price_monthly,
      price_yearly,
      course_price,
      course_duration_days,
      project_defaults,
      ai_limits,
      features,
      usage_limits,
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
                "course_store_visible",
                "priority",
                "price_monthly",
                "price_yearly",
                "course_price",
                "course_duration_days",
                "project_defaults",
                "ai_limits",
                "features",
                "usage_limits",
                "disabled",
                "notes",
                "history",
                "created",
                "updated"
              )
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::JSONB,$11::JSONB,$12::JSONB,$13::JSONB,$14,$15,$16::JSONB,NOW(),NOW())
              ON CONFLICT (id)
              DO UPDATE SET
                "label" = EXCLUDED.label,
                "store_visible" = EXCLUDED.store_visible,
                "course_store_visible" = EXCLUDED.course_store_visible,
                "priority" = EXCLUDED.priority,
                "price_monthly" = EXCLUDED.price_monthly,
                "price_yearly" = EXCLUDED.price_yearly,
                "course_price" = EXCLUDED.course_price,
                "course_duration_days" = EXCLUDED.course_duration_days,
                "project_defaults" = EXCLUDED.project_defaults,
                "ai_limits" = EXCLUDED.ai_limits,
                "features" = EXCLUDED.features,
                "usage_limits" = EXCLUDED.usage_limits,
                "disabled" = EXCLUDED.disabled,
                "notes" = EXCLUDED.notes,
                "history" = EXCLUDED.history,
                "updated" = NOW()`,
      params: [
        id,
        label ?? null,
        store_visible ?? false,
        course_store_visible ?? false,
        priority ?? 0,
        price_monthly ?? null,
        price_yearly ?? null,
        course_price ?? null,
        course_duration_days ?? null,
        toJsonParam(project_defaults),
        toJsonParam(ai_limits),
        toJsonParam(features),
        toJsonParam(usage_limits),
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
