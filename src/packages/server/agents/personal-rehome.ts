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
] as const;

export const EXTERNAL_AGENT_STATE_TABLES = [
  "agent_external_identities",
  "agent_external_installations",
  "agent_external_inbox",
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
        "Account rehome is unavailable while this account has personal agent names, networks, controls, proposals, or external-agent history. Personal agent state portability is not supported yet; keep this account on its current home bay. Pausing messaging does not remove this restriction.",
      );
  }
}
