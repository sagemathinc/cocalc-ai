/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import getPool, {
  getTransactionClient,
  type PoolClient,
} from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { CRM_LIFECYCLE_STAGES, CRM_ORGANIZATION_TYPES } from "@cocalc/util/crm";

const NAMESPACE = "cocalc-local-crm-ar-fixture-v1";
let openedDatabase = false;
type Row = Record<string, unknown> & { id: string };
export type Fixture = { table: string; row: Row }[];

function id(key: string): string {
  const h = createHash("sha256").update(`${NAMESPACE}:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function generateCustomerFixtures(
  actor: string,
  asOf: Date = new Date(),
  count = 24,
): Fixture {
  if (!Number.isInteger(count) || count < 1 || count > 500)
    throw Error("count must be an integer from 1 to 500");
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(actor))
    throw Error("--actor must be an account UUID");
  if (!Number.isFinite(asOf.valueOf())) throw Error("invalid --as-of date");
  const rows: Fixture = [];
  const date = (days: number) =>
    new Date(asOf.valueOf() + days * 86400000).toISOString();
  for (let i = 0; i < count; i++) {
    const org = id(`org-${i}`),
      person = id(`person-${i}`),
      order = id(`order-${i}`);
    const name = `[DEV FIXTURE] ${String(i + 1).padStart(2, "0")} ${["Example University", "Research Institute", "Learning Cooperative", "Department of Computational Science and Applied Mathematics"][i % 4]}`;
    const audit = {
      created_by_account_id: actor,
      updated_by_account_id: actor,
    };
    const add = (table: string, key: string, data: Record<string, unknown>) =>
      rows.push({ table, row: { id: id(`${key}-${i}`), ...data } });
    add("crm_organizations", "org", {
      customer_number: `DEV-CRM-${i + 1}`,
      display_name: name,
      organization_type:
        CRM_ORGANIZATION_TYPES[i % CRM_ORGANIZATION_TYPES.length],
      lifecycle_stage: CRM_LIFECYCLE_STAGES[i % CRM_LIFECYCLE_STAGES.length],
      relationship_owner_account_id: actor,
      ...audit,
    });
    add("crm_people", "person", {
      display_name: `[DEV FIXTURE] Contact ${i + 1}`,
      note: "Synthetic local audit contact. Never contact or link to a real account.",
      ...audit,
    });
    add("crm_person_emails", "email", {
      person_id: person,
      email_address: `contact-${i + 1}@example.invalid`,
      normalized_email: `contact-${i + 1}@example.invalid`,
      is_primary: true,
    });
    add("crm_organization_people", "relation", {
      organization_id: org,
      person_id: person,
      roles: ["billing"],
    });
    add("commercial_orders", "order", {
      order_number: `DEV-AR-${String(i + 1).padStart(3, "0")}`,
      crm_organization_id: org,
      organization_name: name,
      collection_mode: "manual_invoice",
      agreed_subtotal: (i + 1) * 250,
      agreed_total: (i + 1) * 250,
      assignee_account_id: actor,
      created_by_account_id: actor,
      next_action: "Review agreement",
      next_action_due_at: date(i - 12),
      customer_reference: NAMESPACE,
      terms_snapshot: { development_fixture: NAMESPACE },
    });
    add("commercial_order_items", "item", {
      commercial_order_id: order,
      position: 0,
      description: "Synthetic training services - no fulfillment",
      quantity: i + 1,
      unit_amount: 250,
      subtotal: (i + 1) * 250,
      product_kind: "other",
    });
    add("commercial_order_contacts", "contact", {
      commercial_order_id: order,
      crm_person_id: person,
      role: "billing",
      name_snapshot: `[DEV FIXTURE] Contact ${i + 1}`,
      email_snapshot: `contact-${i + 1}@example.invalid`,
    });
    add("crm_opportunities", "opportunity", {
      organization_id: org,
      name: `[DEV FIXTURE] Training proposal ${i + 1}`,
      kind: "training_services",
      stage: ["discovery", "qualified", "proposal", "procurement", "on_hold"][
        i % 5
      ],
      owner_account_id: actor,
      expected_value: (i + 1) * 250,
      expected_close_date: date(i - 8).slice(0, 10),
      ...audit,
    });
    add("crm_tasks", "task", {
      organization_id: org,
      person_id: person,
      opportunity_id: id(`opportunity-${i}`),
      commercial_order_id: order,
      type: "review",
      state: i % 3 === 0 ? "waiting" : "open",
      assignee_account_id: actor,
      due_at: date(i - 12),
      priority: ["low", "normal", "high", "urgent"][i % 4],
      subject: `[DEV FIXTURE] Review synthetic proposal ${i + 1}`,
      ...audit,
    });
    add("crm_activities", "activity", {
      organization_id: org,
      person_id: person,
      commercial_order_id: order,
      kind: "note",
      source: NAMESPACE,
      source_id: String(i),
      summary: "Synthetic customer audit fixture created",
      details:
        "Local-only sample. No invoice, payment, provider operation, or entitlement was created.",
      actor_account_id: actor,
      occurred_at: date(-i),
    });
  }
  return rows;
}

export async function applyCustomerFixtures(
  client: Pick<PoolClient, "query">,
  fixture: Fixture,
): Promise<number> {
  let inserted = 0;
  // Insert-only: repeating the command must not overwrite manual testing edits.
  for (const { table, row } of fixture) {
    const columns = Object.keys(row);
    const result = await client.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")}) ON CONFLICT (id) DO NOTHING`,
      Object.values(row),
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

export function assertFixtureEnvironment(
  environment: string | undefined,
  confirmation: string | undefined,
  bay: string,
  seed: string,
) {
  if (
    environment !== "development" ||
    confirmation !== "seed-local-customer-fixtures"
  )
    throw Error(
      "requires NODE_ENV=development and --confirm seed-local-customer-fixtures",
    );
  if (bay !== seed)
    throw Error("run against the seed bay, not an attached bay");
}

async function main() {
  const { values } = parseArgs({
    options: {
      actor: { type: "string" },
      count: { type: "string" },
      "as-of": { type: "string" },
      apply: { type: "boolean" },
      confirm: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "customer fixtures: --actor <local admin UUID> [--count <1-500>] [--as-of <ISO date>] [--apply --confirm seed-local-customer-fixtures]\nDry-run by default; insert-only and repeatable. Never run against production.\n",
    );
    return;
  }
  const fixture = generateCustomerFixtures(
    values.actor ?? "",
    values["as-of"] ? new Date(values["as-of"]) : new Date(),
    values.count == null ? 24 : Number(values.count),
  );
  if (!values.apply) {
    process.stdout.write(
      `Would insert up to ${fixture.length} rows: ${fixture.length / 10} linked CRM customers and manual draft AR orders.\n`,
    );
    return;
  }
  assertFixtureEnvironment(
    process.env.NODE_ENV,
    values.confirm,
    getConfiguredBayId(),
    getConfiguredClusterSeedBayId(),
  );
  // Never migrate schemas as a side effect of a fixture command or its guards.
  openedDatabase = true;
  const client = await getTransactionClient({ ensureExists: false });
  try {
    const { rows } = await client.query(
      "SELECT inet_server_addr()::text AS address",
    );
    if (
      rows[0].address != null &&
      !["127.0.0.1", "::1"].includes(rows[0].address)
    )
      throw Error("fixtures require a local database");
    const actor = await client.query(
      "SELECT account_id FROM accounts WHERE account_id=$1 AND 'admin'=ANY(groups)",
      [values.actor],
    );
    if (actor.rows.length !== 1)
      throw Error("--actor must be an existing local admin");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      NAMESPACE,
    ]);
    const count = await applyCustomerFixtures(client, fixture);
    await client.query("COMMIT");
    process.stdout.write(
      `Inserted ${count} synthetic CRM/AR rows. No provider operations performed.\n`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module)
  main()
    .catch((err) => {
      process.stderr.write(`${err}\n`);
      process.exitCode = 1;
    })
    .finally(() =>
      openedDatabase ? getPool({ ensureExists: false }).end() : undefined,
    );
