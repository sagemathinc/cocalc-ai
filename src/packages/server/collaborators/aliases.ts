import getPool from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import { uuid } from "@cocalc/database/postgres/collaborators/collaborators-common";
import { bumpCollaborationRevision } from "@cocalc/database/postgres/collaborators/collaborators-changes";
import {
  MAX_PERSON_ALIASES,
  normalizePrivateAlias,
  PERSON_ALIASES_SETTING,
  personAliases,
} from "@cocalc/util/private-alias";
import type { CollaborationTarget } from "@cocalc/util/collaborators";

/** All callers must resolve/check the authenticated account's home first. */
export async function readPersonAliases(account_id: string) {
  const row = (
    await getPool().query(
      "SELECT other_settings->$2 AS aliases FROM accounts WHERE account_id=$1",
      [account_id, PERSON_ALIASES_SETTING],
    )
  ).rows[0];
  return personAliases(row?.aliases);
}

export async function writePersonAlias(
  account_id: string,
  person_id: string,
  value: string,
  checkAccess: () => Promise<void>,
): Promise<{ alias: string | null }> {
  uuid(person_id, "person_id");
  person_id = person_id.toLowerCase();
  if (typeof value !== "string") throw Error("Invalid private alias");
  const alias = value.trim() ? normalizePrivateAlias(value) : null;
  return withAccountRehomeWriteFence({
    account_id,
    action: "change private person alias",
    fn: async (db) => {
      await checkAccess();
      const row = (
        await db.query(
          "SELECT other_settings->$2 AS aliases FROM accounts WHERE account_id=$1 FOR UPDATE",
          [account_id, PERSON_ALIASES_SETTING],
        )
      ).rows[0];
      const aliases = personAliases(row?.aliases);
      delete aliases[person_id];
      if (alias) {
        if (Object.values(aliases).includes(alias))
          throw Error("You already use this alias for another person");
        if (Object.keys(aliases).length >= MAX_PERSON_ALIASES)
          throw Error("Person alias limit reached");
        aliases[person_id] = alias;
      }
      // Update only our key, preserving concurrent unrelated account preferences.
      await db.query(
        "UPDATE accounts SET other_settings=jsonb_set(COALESCE(other_settings,'{}'),ARRAY[$2::text],$3::jsonb) WHERE account_id=$1",
        [account_id, PERSON_ALIASES_SETTING, JSON.stringify(aliases)],
      );
      await bumpCollaborationRevision(db, account_id);
      return { alias };
    },
  });
}

/** Reuse both existing chat-name stores; ambiguous legacy labels fail closed. */
export async function chatAliasTarget(
  account_id: string,
  name: string,
): Promise<CollaborationTarget | null> {
  const alias = normalizePrivateAlias(name);
  const { rows } = await getPool().query(
    `SELECT DISTINCT project_id,kind,resource_id FROM (
      SELECT n.project_id,'agent' AS kind,n.agent_id::text AS resource_id
      FROM agent_personal_names n WHERE n.account_id=$1 AND n.name=$2 AND n.retired_at IS NULL
      UNION ALL
      SELECT r.project_id,r.kind,r.metadata->>'resource_id' AS resource_id FROM collaboration_personal s
      JOIN collaboration_index r ON r.account_id=s.account_id AND r.entry_key=s.entry_key
      WHERE s.account_id=$1 AND lower(btrim(s.alias))=$2 AND r.kind IN ('conversation','agent')
    ) names LIMIT 2`,
    [account_id, alias],
  );
  return rows.length === 1 ? rows[0] : null;
}
