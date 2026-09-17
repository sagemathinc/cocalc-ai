import getPool from "@cocalc/database/pool";
import { FUNDING_ACCOUNT_WRITER_PROTOCOL_VERSION } from "@cocalc/server/purchases/lock-account-spending";
import { FUNDING_WRITER_PROTOCOL_VERSION } from "@cocalc/util/compute-funding-rollout";
import type {
  FundingRolloutManifest,
  FundingRolloutBay,
} from "./production-rollout-contract";

// Every table whose mutation can change account money, financial policy,
// sponsored-compute backing, or the durable record of those changes. The
// rollout verifier intentionally over-includes adjacent journals and work
// queues so an old credential cannot retain a financially meaningful write
// path while passing attestation.
export const FUNDING_AUTHORITY_TABLES = [
  "accounts",
  "account_entitlement_overrides",
  "account_second_factors",
  "admin_assigned_memberships",
  "billing_accounts",
  "purchases",
  "subscriptions",
  "statements",
  "payment_fulfillments",
  "provider_refund_attempts",
  "subscription_renewal_attempts",
  "admin_membership_orders",
  "admin_membership_package_intents",
  "membership_grants",
  "membership_package_assignments",
  "membership_packages",
  "membership_tiers",
  "server_settings",
  "billing_authority_commands",
  "billing_authority_lease",
  "billing_authority_account_fences",
  "billing_authority_migrations",
  "credit_transfer_ledger_observations",
  "credit_payment_roots",
  "credit_transfers",
  "credit_transfer_deliveries",
  "credit_transfer_entries",
  "account_usage_windows",
  "account_usage_epochs",
  "account_usage_epoch_resets",
  "account_usage_counters",
  "account_usage_counter_states",
  "account_funding_holds",
  "account_funding_authorities",
  "compute_funding_exposure_policy",
  "compute_funding_pools",
  "compute_funding_grants",
  "compute_funding_reservations",
  "compute_funding_events",
  "compute_funding_purchase_attributions",
  "compute_vm_personal_consents",
  "compute_vms",
  "compute_volumes",
  "compute_resource_work",
  "compute_resource_events",
  "compute_site_funded_usage",
  "compute_egress_meter_intervals",
] as const;

export async function listFundingAuthorityWriterRoles(
  db: Pick<ReturnType<typeof getPool>, "query"> = getPool(),
): Promise<{ role: string; superuser: boolean; bypass_rls: boolean }[]> {
  const { rows } = await db.query<{
    role: string;
    superuser: boolean;
    bypass_rls: boolean;
  }>(
    `WITH tables AS (SELECT oid FROM pg_class WHERE relname=ANY($1::text[]) AND relnamespace='public'::regnamespace)
     SELECT login.rolname AS role, login.rolsuper AS superuser, login.rolbypassrls AS bypass_rls
     FROM pg_roles login
     WHERE login.rolcanlogin AND has_database_privilege(login.oid,current_database(),'CONNECT')
       AND (login.rolsuper OR EXISTS (
         SELECT 1 FROM pg_roles reachable CROSS JOIN tables
         WHERE pg_has_role(login.oid,reachable.oid,'MEMBER')
           AND has_table_privilege(reachable.oid,tables.oid,'INSERT,UPDATE,DELETE,TRUNCATE')))
     ORDER BY login.rolname`,
    [FUNDING_AUTHORITY_TABLES],
  );
  return rows;
}

export function fundingWriterBuildId(): string | undefined {
  return (
    process.env.COCALC_FUNDING_WRITER_BUILD_ID ||
    process.env.COCALC_LAUNCHPAD_ARTIFACT_ID ||
    process.env.COCALC_STAR_RELEASE_ID ||
    process.env.STAR_RELEASE_ID
  );
}

/** Read-only verification of signed deployment claims against actual PostgreSQL
 * identity and privilege holders. Revocation is an operator action, never an
 * automatic mutation performed by a funding request.
 */
export async function verifyFundingAccountWriters(
  _manifest: FundingRolloutManifest,
  bay: FundingRolloutBay,
): Promise<void> {
  if (
    FUNDING_ACCOUNT_WRITER_PROTOCOL_VERSION !== FUNDING_WRITER_PROTOCOL_VERSION
  )
    throw Error("This account writer does not implement the funding protocol.");
  const pool = getPool();
  const {
    rows: [identity],
  } = await pool.query<{
    database: string;
    role: string;
    system_identifier: string;
  }>(
    "SELECT current_database() AS database, current_user AS role, system_identifier::text FROM pg_control_system()",
  );
  const writer = bay.writers.find(
    (w) => w.id === process.env.COCALC_FUNDING_WRITER_ID,
  );
  if (
    !identity ||
    identity.database !== bay.database.name ||
    identity.system_identifier !== bay.database.system_identifier ||
    !writer ||
    writer.database_role !== identity.role ||
    writer.build_id !== fundingWriterBuildId()
  )
    throw Error(
      "Funding writer/database identity differs from the deployment manifest.",
    );

  // Include inherited and SET ROLE reachable privileges, not just direct grants.
  // Operator roles are explicitly inventoried in the signed manifest; they are
  // trusted administrators, not unnamed application-worker exceptions.
  const writers = await listFundingAuthorityWriterRoles(pool);
  const allowed = new Set([
    ...bay.database.writer_roles,
    ...bay.database.operator_roles,
  ]);
  if (
    writers.some((w) => !allowed.has(w.role)) ||
    bay.database.writer_roles.some(
      (role) => !writers.some((w) => w.role === role),
    )
  )
    throw Error(
      "Actual PostgreSQL writer coverage differs from the signed inventory.",
    );
  if (
    writers.some(
      (w) =>
        bay.database.writer_roles.includes(w.role) &&
        (w.superuser || w.bypass_rls),
    )
  )
    throw Error(
      "Application funding writers require dedicated non-superuser credentials.",
    );
  const retired = bay.database.retired_roles.map((r) => r.id);
  if (retired.length) {
    const { rows } = await pool.query(
      `SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[]) AND rolcanlogin
       UNION SELECT usename FROM pg_stat_activity WHERE usename=ANY($1::text[])`,
      [retired],
    );
    if (rows.length)
      throw Error(
        "Retired funding database credentials still permit login or have live sessions.",
      );
  }
}
