import { GPU_PROVIDER_API_KEY_KIND } from "@cocalc/util/gpu/provider-keys";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
} from "@cocalc/server/accounts/rehome-fence";

export const PERSONAL_AGENT_STATE_TABLES = [
  "agent_personal_names",
  "agent_personal_controls",
  "agent_networks",
  "agent_network_mutations",
  "agent_network_activity",
  "agent_network_proposals",
  "agent_network_broadcasts",
  "personal_library_controls",
  "personal_library_aliases",
  "personal_library_pins",
  "account_people_state",
] as const;

export const EXTERNAL_AGENT_STATE_TABLES = [
  "agent_external_identities",
  "agent_external_installations",
  "agent_external_inbox",
  "agent_external_inbox_attachments",
  "agent_external_inbox_reservations",
] as const;

/** Computers live at their account's home bay: no rehome while any remain,
 * including their pairing requests. */
export const COMPUTER_STATE_TABLES = [
  "paired_computers",
  "computer_pairing_requests",
] as const;

// GPU state of a key owner (BYOK pods, budget layers, the key's fence and
// admins' stale-worker overrides, history included: all account-home audit
// records), keyed by key_owner_account_id.
// Its pods run on the owner's own RunPod account and are managed only from
// the home bay, so it must not be left behind by a rehome.
export const GPU_STATE_TABLES = [
  "gpu_pods",
  "gpu_budget_layers",
  "gpu_key_fences",
  "gpu_worker_overrides",
  "gpu_key_events",
] as const;

// Agents' GPU requests and grants (6b), keyed by the key owner's account_id.
export const GPU_AGENT_STATE_TABLES = [
  "gpu_agent_requests",
  "gpu_agent_grants",
] as const;

export type PersonalAuthorityDb = {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
};

/** Call inside the same transaction that reads authority or mutates state. */
export async function assertPersonalAccountAuthority(
  db: PersonalAuthorityDb,
  account_id: string,
) {
  await assertAccountNotRehoming({
    db,
    account_id,
    action: "use personal agent messaging",
  });
  await assertAccountWriteOnHomeBay({
    db,
    account_id,
    action: "use personal agent messaging",
  });
}

/** Caller holds the canonical account-rehome transaction fence. No flag gate:
 * switching the prototype off must not allow its retained state to be lost. */
export async function assertNoPersonalStateForRehome(
  db: PersonalAuthorityDb,
  account_id: string,
) {
  const tables = [
    ...PERSONAL_AGENT_STATE_TABLES,
    ...EXTERNAL_AGENT_STATE_TABLES,
    ...COMPUTER_STATE_TABLES,
  ];
  const existing = new Set(
    (
      await db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])",
        [tables],
      )
    ).rows.map((row) => row.table_name),
  );
  for (const table of tables) {
    if (!existing.has(table)) continue;
    if (
      (
        await db.query(`SELECT 1 FROM "${table}" WHERE account_id=$1 LIMIT 1`, [
          account_id,
        ])
      ).rows.length
    )
      throw new Error(
        "Account rehome is unavailable while this account has People state, personal agent names, networks, controls, proposals, computers, or external-agent history. Personal state portability is not supported yet; keep this account on its current home bay. Pausing messaging does not remove this restriction.",
      );
  }
  const gpuExisting = new Set(
    (
      await db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])",
        [[...GPU_STATE_TABLES, ...GPU_AGENT_STATE_TABLES]],
      )
    ).rows.map((row) => row.table_name),
  );
  const gpuTables: [string, string][] = [
    ...GPU_STATE_TABLES.map((t): [string, string] => [
      t,
      "key_owner_account_id",
    ]),
    ...GPU_AGENT_STATE_TABLES.map((t): [string, string] => [t, "account_id"]),
  ];
  for (const [table, column] of gpuTables) {
    if (!gpuExisting.has(table)) continue;
    if (
      (
        await db.query(`SELECT 1 FROM "${table}" WHERE ${column}=$1 LIMIT 1`, [
          account_id,
        ])
      ).rows.length
    )
      throw new Error(
        "Account rehome is unavailable while this account has GPU pods, GPU budgets or an admin GPU override on its own RunPod key. GPU state portability is not supported yet; keep this account on its current home bay.",
      );
  }
  // A connected GPU provider key lives (encrypted) on the home bay only.
  const credentials = await db.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='external_credentials'",
  );
  if (
    credentials.rows.length &&
    (
      await db.query(
        "SELECT 1 FROM external_credentials WHERE owner_account_id=$1 AND kind=$2 AND revoked IS NULL LIMIT 1",
        [account_id, GPU_PROVIDER_API_KEY_KIND],
      )
    ).rows.length
  ) {
    throw new Error(
      "Account rehome is unavailable while this account has a GPU provider key connected. Remove the key first (Settings → Connectors), or keep this account on its current home bay.",
    );
  }
}
