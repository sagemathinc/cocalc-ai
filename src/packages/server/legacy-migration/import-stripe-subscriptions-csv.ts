/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readFile } from "fs/promises";

import getPool from "@cocalc/database/pool";

const SOURCE = "stripe_subscriptions";

type Options = {
  file?: string;
  apply: boolean;
};

type StripeSubscriptionCsvRow = {
  subscription_id: string;
  stripe_customer_id: string;
  customer_email: string | null;
  plan: string;
  quantity: number;
  currency: string;
  interval: string;
  amount: number;
  status: string;
  created: string | null;
  start_date: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  customer_name: string | null;
  service_metadata: string | null;
  invoice_ninja_metadata: string | null;
  account_id_metadata: string | null;
  license_id_metadata: string | null;
};

let poolUsed = false;

function pool() {
  poolUsed = true;
  return getPool();
}

function usage(): never {
  console.log(`Usage:
  node packages/server/dist/legacy-migration/import-stripe-subscriptions-csv.js --file /scratch/dump/subscriptions.csv [--apply]

Imports a fresh Stripe subscriptions CSV export into legacy_migration_raw_records
with source='${SOURCE}'. Without --apply this is a dry run.
`);
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    const value = argv[++i];
    if (value == null || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    if (arg === "--file") {
      options.file = value;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!options.file) {
    throw new Error("--file is required");
  }
  return options;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((row) => row.some((field) => field.trim() !== ""));
}

function clean(value: unknown): string | null {
  const s = `${value ?? ""}`.trim();
  return s || null;
}

function numberValue(value: unknown): number {
  const n = Number(`${value ?? ""}`.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function utcIso(value: unknown): string | null {
  const s = clean(value);
  if (!s) return null;
  const ms = new Date(`${s.replace(" ", "T")}Z`).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : s;
}

function normalizeRows(text: string): StripeSubscriptionCsvRow[] {
  const rows = parseCsv(text);
  const headers = rows.shift();
  if (!headers) return [];
  const index = new Map(headers.map((field, i) => [field, i]));
  const get = (row: string[], field: string) => row[index.get(field) ?? -1];
  return rows
    .map((row) => ({
      subscription_id: clean(get(row, "id")) ?? "",
      stripe_customer_id: clean(get(row, "Customer ID")) ?? "",
      customer_email: clean(get(row, "Customer Email")),
      plan: clean(get(row, "Plan")) ?? "",
      quantity: numberValue(get(row, "Quantity")) || 1,
      currency: (clean(get(row, "Currency")) ?? "").toLowerCase(),
      interval: clean(get(row, "Interval")) ?? "",
      amount: numberValue(get(row, "Amount")),
      status: clean(get(row, "Status")) ?? "",
      created: utcIso(get(row, "Created (UTC)")),
      start_date: utcIso(get(row, "Start Date (UTC)")),
      current_period_start: utcIso(get(row, "Current Period Start (UTC)")),
      current_period_end: utcIso(get(row, "Current Period End (UTC)")),
      customer_name: clean(get(row, "Customer Name")),
      service_metadata: clean(get(row, "service (metadata)")),
      invoice_ninja_metadata: clean(get(row, "invoice_ninja (metadata)")),
      account_id_metadata: clean(get(row, "account_id (metadata)")),
      license_id_metadata: clean(get(row, "license_id (metadata)")),
    }))
    .filter((row) => row.subscription_id && row.stripe_customer_id);
}

async function ensureRawRecordsSchema(): Promise<void> {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS legacy_migration_raw_records (
      source VARCHAR(64) NOT NULL,
      legacy_id TEXT NOT NULL,
      payload JSONB NOT NULL,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      updated TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source, legacy_id)
    )
  `);
  await pool().query(`
    CREATE INDEX IF NOT EXISTS legacy_migration_raw_records_updated_idx
      ON legacy_migration_raw_records(updated)
  `);
}

async function upsertRows(rows: StripeSubscriptionCsvRow[]): Promise<void> {
  await ensureRawRecordsSchema();
  await pool().query(
    `
    WITH input AS (
      SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          source TEXT,
          legacy_id TEXT,
          payload JSONB
        )
    )
    INSERT INTO legacy_migration_raw_records (
      source, legacy_id, payload, created, updated
    )
    SELECT source, legacy_id, payload, NOW(), NOW()
      FROM input
     WHERE COALESCE(source, '') <> ''
       AND COALESCE(legacy_id, '') <> ''
    ON CONFLICT (source, legacy_id) DO UPDATE SET
      payload=EXCLUDED.payload,
      updated=NOW()
    `,
    [
      JSON.stringify(
        rows.map((row) => ({
          source: SOURCE,
          legacy_id: row.subscription_id,
          payload: row,
        })),
      ),
    ],
  );
}

function summarize(rows: StripeSubscriptionCsvRow[]): void {
  const plans = new Map<string, number>();
  for (const row of rows) {
    const key = [
      row.status,
      row.plan,
      row.interval,
      row.currency,
      row.amount.toFixed(2),
    ].join("|");
    plans.set(key, (plans.get(key) ?? 0) + 1);
  }
  console.log(`rows=${rows.length}`);
  for (const [key, count] of [...plans.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${count} ${key}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rows = normalizeRows(await readFile(options.file!, "utf8"));
  console.log(`${options.apply ? "apply" : "dry-run"} ${options.file}`);
  summarize(rows);
  if (options.apply) {
    await upsertRows(rows);
    console.log(`imported ${rows.length} Stripe subscription row(s)`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (poolUsed) {
      await getPool().end();
    }
  });
