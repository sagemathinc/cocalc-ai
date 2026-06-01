/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  AbuseReviewAnnotation,
  AbuseReviewCategory,
  AbuseReviewDisposition,
  AbuseReviewPriorityAdjustment,
} from "@cocalc/conat/hub/api/purchases";

const TABLE = "account_abuse_review_annotations";

const CATEGORIES = new Set<AbuseReviewCategory>([
  "cpu",
  "egress",
  "storage",
  "signup",
  "payment",
  "general",
]);

const DISPOSITIONS = new Set<AbuseReviewDisposition>([
  "legitimate",
  "suspicious",
  "abusive",
  "needs_followup",
  "false_positive",
]);

const PRIORITY_ADJUSTMENTS = new Set<AbuseReviewPriorityAdjustment>([
  "suppress",
  "lower",
  "normal",
  "raise",
  "urgent",
]);

let ensuredSchema: Promise<void> | undefined;

async function ensureSchema(): Promise<void> {
  if (!ensuredSchema) {
    ensuredSchema = (async () => {
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          account_id UUID NOT NULL,
          project_id UUID,
          category TEXT NOT NULL,
          disposition TEXT NOT NULL,
          priority_adjustment TEXT NOT NULL DEFAULT 'normal',
          reason TEXT NOT NULL,
          evidence JSONB,
          created_by UUID NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ,
          revoked_by UUID,
          revoked_at TIMESTAMPTZ,
          revoked_reason TEXT
        )
      `);
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_account_idx ON ${TABLE}(account_id, created_at DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_project_idx ON ${TABLE}(project_id, created_at DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_active_idx ON ${TABLE}(account_id, category, expires_at) WHERE revoked_at IS NULL`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_created_by_idx ON ${TABLE}(created_by, created_at DESC)`,
      );
    })();
  }
  await ensuredSchema;
}

function normalizeRequiredText(value: unknown, name: string): string {
  const text = `${value ?? ""}`.trim();
  if (!text) {
    throw Error(`${name} is required`);
  }
  return text;
}

function normalizeOptionalId(value: unknown): string | undefined {
  const text = `${value ?? ""}`.trim();
  return text || undefined;
}

function normalizeCategory(value?: string): AbuseReviewCategory {
  const category = `${value ?? "cpu"}`.trim() as AbuseReviewCategory;
  if (!CATEGORIES.has(category)) {
    throw Error("invalid abuse review category");
  }
  return category;
}

function normalizeDisposition(value?: string): AbuseReviewDisposition {
  const disposition =
    `${value ?? "needs_followup"}`.trim() as AbuseReviewDisposition;
  if (!DISPOSITIONS.has(disposition)) {
    throw Error("invalid abuse review disposition");
  }
  return disposition;
}

function normalizePriorityAdjustment(
  value?: string,
): AbuseReviewPriorityAdjustment {
  const priority =
    `${value ?? "normal"}`.trim() as AbuseReviewPriorityAdjustment;
  if (!PRIORITY_ADJUSTMENTS.has(priority)) {
    throw Error("invalid abuse review priority adjustment");
  }
  return priority;
}

function normalizeTimestamp(value?: string | Date | null): Date | null {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw Error("invalid timestamp");
  }
  return date;
}

function mapAnnotationRow(row: any): AbuseReviewAnnotation {
  return {
    id: row.id,
    account_id: row.account_id,
    project_id: row.project_id ?? null,
    category: row.category,
    disposition: row.disposition,
    priority_adjustment: row.priority_adjustment,
    reason: row.reason,
    evidence: row.evidence ?? null,
    created_by: row.created_by,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    revoked_by: row.revoked_by ?? null,
    revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    revoked_reason: row.revoked_reason ?? null,
  };
}

export async function createAbuseReviewAnnotation(opts: {
  account_id?: string;
  project_id?: string | null;
  category?: AbuseReviewCategory;
  disposition?: AbuseReviewDisposition;
  priority_adjustment?: AbuseReviewPriorityAdjustment;
  reason?: string;
  evidence?: Record<string, unknown> | null;
  created_by?: string;
  expires_at?: string | Date | null;
}): Promise<AbuseReviewAnnotation> {
  await ensureSchema();
  const account_id = normalizeRequiredText(opts.account_id, "account_id");
  const created_by = normalizeRequiredText(opts.created_by, "created_by");
  const reason = normalizeRequiredText(opts.reason, "reason").slice(0, 4000);
  const { rows } = await getPool("medium").query(
    `
      INSERT INTO ${TABLE}
        (
          account_id,
          project_id,
          category,
          disposition,
          priority_adjustment,
          reason,
          evidence,
          created_by,
          expires_at
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
      RETURNING *
    `,
    [
      account_id,
      normalizeOptionalId(opts.project_id) ?? null,
      normalizeCategory(opts.category),
      normalizeDisposition(opts.disposition),
      normalizePriorityAdjustment(opts.priority_adjustment),
      reason,
      opts.evidence ?? null,
      created_by,
      normalizeTimestamp(opts.expires_at),
    ],
  );
  return mapAnnotationRow(rows[0]);
}

export async function revokeAbuseReviewAnnotation(opts: {
  id?: string;
  revoked_by?: string;
  revoked_reason?: string;
}): Promise<AbuseReviewAnnotation> {
  await ensureSchema();
  const id = normalizeRequiredText(opts.id, "id");
  const revoked_by = normalizeRequiredText(opts.revoked_by, "revoked_by");
  const revoked_reason = normalizeRequiredText(
    opts.revoked_reason,
    "revoked_reason",
  ).slice(0, 4000);
  const { rows } = await getPool("medium").query(
    `
      UPDATE ${TABLE}
         SET revoked_by = $2,
             revoked_at = now(),
             revoked_reason = $3
       WHERE id = $1
       RETURNING *
    `,
    [id, revoked_by, revoked_reason],
  );
  if (rows.length === 0) {
    throw Error("annotation not found");
  }
  return mapAnnotationRow(rows[0]);
}

export async function listAbuseReviewAnnotations(opts: {
  account_id?: string;
  project_id?: string | null;
  category?: AbuseReviewCategory;
  active_only?: boolean;
  limit?: number;
}): Promise<AbuseReviewAnnotation[]> {
  await ensureSchema();
  const account_id = normalizeRequiredText(opts.account_id, "account_id");
  const params: any[] = [account_id];
  const where = ["account_id = $1"];
  const project_id = normalizeOptionalId(opts.project_id);
  if (project_id) {
    params.push(project_id);
    where.push(`project_id = $${params.length}`);
  }
  if (opts.category) {
    params.push(normalizeCategory(opts.category));
    where.push(`category = $${params.length}`);
  }
  if (opts.active_only) {
    where.push("revoked_at IS NULL");
    where.push("(expires_at IS NULL OR expires_at > now())");
  }
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit)
      ? Math.max(1, Math.min(100, Math.floor(opts.limit)))
      : 50;
  params.push(limit);
  const { rows } = await getPool("medium").query(
    `
      SELECT *
        FROM ${TABLE}
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}
    `,
    params,
  );
  return rows.map(mapAnnotationRow);
}

export async function listActiveAbuseReviewAnnotations(opts: {
  account_ids?: string[];
  project_ids?: Array<string | null | undefined>;
  categories?: AbuseReviewCategory[];
}): Promise<AbuseReviewAnnotation[]> {
  await ensureSchema();
  const accountIds = [
    ...new Set(
      (opts.account_ids ?? []).map(normalizeOptionalId).filter(Boolean),
    ),
  ];
  if (accountIds.length === 0) {
    return [];
  }
  const projectIds = [
    ...new Set(
      (opts.project_ids ?? []).map(normalizeOptionalId).filter(Boolean),
    ),
  ];
  const categories = [
    ...new Set(
      (opts.categories ?? []).map((category) => normalizeCategory(category)),
    ),
  ];
  const params: any[] = [accountIds];
  const where = [
    "account_id = ANY($1::uuid[])",
    "revoked_at IS NULL",
    "(expires_at IS NULL OR expires_at > now())",
  ];
  if (projectIds.length > 0) {
    params.push(projectIds);
    where.push(
      `(project_id IS NULL OR project_id = ANY($${params.length}::uuid[]))`,
    );
  }
  if (categories.length > 0) {
    params.push(categories);
    where.push(`category = ANY($${params.length}::text[])`);
  }
  const { rows } = await getPool("medium").query(
    `
      SELECT *
        FROM ${TABLE}
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, id DESC
    `,
    params,
  );
  return rows.map(mapAnnotationRow);
}
