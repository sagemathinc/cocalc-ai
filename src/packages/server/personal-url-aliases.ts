/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { requireUuid } from "@cocalc/conat/agents/protocol";
import { createInterBayPersonalUrlAliasesClient } from "@cocalc/conat/inter-bay/personal-url-aliases";
import type { PersonalUrlAliasesApi } from "@cocalc/conat/inter-bay/personal-url-aliases";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import {
  normalizePrivateAlias,
  PERSON_ALIASES_SETTING,
  personAliases,
} from "@cocalc/util/private-alias";
import { resolveAccountHomeBay } from "./bay-directory";
import { getConfiguredBayId } from "./bay-config";
import { getInterBayFabricClient } from "./inter-bay/fabric";

export const personalUrlAliasHomeControl: PersonalUrlAliasesApi = {
  async lookup({ owner_account_id, home_bay_id, kind, alias }) {
    requireUuid(owner_account_id, "owner_account_id");
    const current = await resolveAccountHomeBay({
      account_id: owner_account_id,
    });
    if (
      home_bay_id !== getConfiguredBayId() ||
      current.home_bay_id !== home_bay_id
    )
      throw Error("Stale account-home route");
    const name = normalizePrivateAlias(alias);
    // The rehome fence covers the authority check and the exact alias read in
    // one transaction, so a stale home cannot resolve copied personal state.
    return withAccountRehomeWriteFence({
      account_id: owner_account_id,
      action: "resolve personal URL",
      fn: async (db) => {
        const { rows: accounts } = await db.query(
          "SELECT other_settings->$2 AS aliases FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE AND banned IS NOT TRUE",
          [owner_account_id, PERSON_ALIASES_SETTING],
        );
        if (!accounts.length) return null;
        switch (kind) {
          case "agents": {
            const { rows } = await db.query(
              "SELECT project_id,agent_id FROM agent_personal_names WHERE account_id=$1 AND name=$2 AND retired_at IS NULL",
              [owner_account_id, name],
            );
            return rows.length === 1
              ? {
                  kind: "agent",
                  project_id: rows[0].project_id,
                  agent_id: rows[0].agent_id,
                }
              : null;
          }
          case "artifacts": {
            const { rows } = await db.query(
              "SELECT project_id,entry_id FROM personal_library_aliases WHERE account_id=$1 AND name=$2",
              [owner_account_id, name],
            );
            return rows.length === 1
              ? {
                  kind: "artifact",
                  project_id: rows[0].project_id,
                  entry_id: rows[0].entry_id,
                }
              : null;
          }
          case "chats": {
            const { rows } = await db.query(
              `SELECT DISTINCT project_id,kind,resource_id FROM (
                SELECT n.project_id,'agent' AS kind,n.agent_id::text AS resource_id
                FROM agent_personal_names n WHERE n.account_id=$1 AND n.name=$2 AND n.retired_at IS NULL
                UNION ALL
                SELECT r.project_id,r.kind,r.metadata->>'resource_id' AS resource_id FROM collaboration_personal s
                JOIN collaboration_index r ON r.account_id=s.account_id AND r.entry_key=s.entry_key
                WHERE s.account_id=$1 AND lower(btrim(s.alias))=$2 AND r.kind IN ('conversation','agent')
              ) names LIMIT 2`,
              [owner_account_id, name],
            );
            return rows.length === 1
              ? {
                  kind: "conversation",
                  project_id: rows[0].project_id,
                  resource_id: rows[0].resource_id,
                  resource_kind: rows[0].kind,
                }
              : null;
          }
          case "people": {
            const person_id = Object.entries(
              personAliases(accounts[0].aliases),
            ).find(([, value]) => value === name)?.[0];
            return person_id ? { kind: "person", person_id } : null;
          }
          default:
            throw Error("Invalid personal URL kind");
        }
      },
    });
  },
};

export async function lookupPersonalUrlAlias(
  opts: Omit<Parameters<PersonalUrlAliasesApi["lookup"]>[0], "home_bay_id">,
) {
  requireUuid(opts.owner_account_id, "owner_account_id");
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id: opts.owner_account_id,
  });
  if (!home_bay_id) throw Error("Account home unavailable");
  const api =
    home_bay_id === getConfiguredBayId()
      ? personalUrlAliasHomeControl
      : createInterBayPersonalUrlAliasesClient(
          getInterBayFabricClient(),
          home_bay_id,
        );
  return api.lookup({ ...opts, home_bay_id });
}
