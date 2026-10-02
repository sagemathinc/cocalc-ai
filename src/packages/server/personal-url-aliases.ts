/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { requireUuid } from "@cocalc/conat/agents/protocol";
import { createInterBayPersonalUrlAliasesClient } from "@cocalc/conat/inter-bay/personal-url-aliases";
import type { PersonalUrlAliasesApi } from "@cocalc/conat/inter-bay/personal-url-aliases";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import { normalizeAlias } from "@cocalc/util/people";
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
    const name = normalizeAlias(alias);
    if (name == null) return null;
    // The rehome fence covers the authority check and the exact alias read in
    // one transaction, so a stale home cannot resolve copied personal state.
    return withAccountRehomeWriteFence({
      account_id: owner_account_id,
      action: "resolve personal URL",
      fn: async (db) => {
        const { rows: accounts } = await db.query(
          "SELECT 1 FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE AND banned IS NOT TRUE",
          [owner_account_id],
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
              `SELECT project_id, target_id FROM account_people_state
               WHERE account_id=$1 AND kind='conversation' AND alias=$2`,
              [owner_account_id, name],
            );
            return rows.length === 1
              ? {
                  kind: "conversation",
                  project_id: rows[0].project_id,
                  conversation_id: rows[0].target_id,
                }
              : null;
          }
          case "projects": {
            const { rows } = await db.query(
              `SELECT target_id FROM account_people_state
               WHERE account_id=$1 AND kind='project' AND alias=$2`,
              [owner_account_id, name],
            );
            return rows.length === 1
              ? { kind: "project", project_id: rows[0].target_id }
              : null;
          }
          case "people": {
            const { rows } = await db.query(
              `SELECT target_id FROM account_people_state
               WHERE account_id=$1 AND kind='person' AND alias=$2`,
              [owner_account_id, name],
            );
            return rows.length === 1
              ? { kind: "person", person_id: rows[0].target_id }
              : null;
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
