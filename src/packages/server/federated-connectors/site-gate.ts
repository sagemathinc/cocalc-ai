/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The site gate for federated connectors (the federated_cli_connectors
setting). It changes only here, on the seed bay, by an admin with fresh
authentication, and in one transaction with its append-only audit row: if
the audit row can't be written, the setting doesn't change. The generic site
settings path refuses this setting (server/conat/api/system.ts).

After commit the new value goes to the other bays through the usual site
settings propagation; a bay that misses it is fixed by the next settings
sync from the seed. Bays never change the gate locally.
*/

import getPool from "@cocalc/database/pool";
import { resetServerSettingsCache } from "@cocalc/database/settings/server-settings";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import {
  FEDERATED_CLI_CONNECTORS,
  FEDERATED_GATE_SETTING,
  parseFederatedGate,
  type FederatedCliConnector,
} from "@cocalc/util/ai/federated-connectors";
import { recordFederatedAccessAudit } from "./audit";

export async function setFederatedConnectorGateOnSeed({
  account_id,
  session_hash,
  connectors,
}: {
  account_id?: string;
  session_hash?: string;
  connectors: string[];
}): Promise<{ connectors: FederatedCliConnector[] }> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("only an admin can change the federated connector gate");
  }
  if (getConfiguredBayId() !== getConfiguredClusterSeedBayId()) {
    throw Error("the federated connector gate is changed on the seed bay");
  }
  if (
    !Array.isArray(connectors) ||
    connectors.some(
      (c) => !(FEDERATED_CLI_CONNECTORS as readonly string[]).includes(c),
    )
  ) {
    throw Error("unknown federated connector");
  }
  const after = parseFederatedGate(connectors.join(","));
  const session = await requireDangerousSessionAuth({
    account_id,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      value: string | null;
      readonly: boolean | null;
    }>(`SELECT value, readonly FROM server_settings WHERE name=$1 FOR UPDATE`, [
      FEDERATED_GATE_SETTING,
    ]);
    if (rows[0]?.readonly) {
      throw Error("the federated connector gate is set by configuration");
    }
    const before = parseFederatedGate(rows[0]?.value);
    if (before.join(",") === after.join(",")) {
      throw Error("nothing to change");
    }
    await client.query(
      `INSERT INTO server_settings (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value`,
      [FEDERATED_GATE_SETTING, after.join(",")],
    );
    await recordFederatedAccessAudit(client, {
      action: "site-gate-change",
      actor_account_id: account_id,
      session,
      before: { connectors: before },
      after: { connectors: after },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  resetServerSettingsCache();

  const {
    propagateSiteSettingsToBays,
    recordGlobalConfigEventOnSeed,
    SERVER_SETTINGS_CONFIG_SCOPE,
  } = await import("@cocalc/server/conat/api/system");
  const update = { name: FEDERATED_GATE_SETTING, value: after.join(",") };
  const version = await recordGlobalConfigEventOnSeed({
    scope: SERVER_SETTINGS_CONFIG_SCOPE,
    account_id,
    changes: { settings: [FEDERATED_GATE_SETTING] },
  });
  await propagateSiteSettingsToBays([update], {
    scope: SERVER_SETTINGS_CONFIG_SCOPE,
    version,
  });
  return { connectors: after };
}
