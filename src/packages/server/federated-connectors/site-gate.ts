/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The protected federated connector settings: the site gate
(federated_cli_connectors) and the two trust roots, the broker signer record
(federated_broker_signer) and the issuer key pins (federated_issuer_key_pins).
Each changes only here, on the seed bay, by an admin with fresh
authentication, and in one transaction with its append-only audit row: if
the audit row can't be written, the setting doesn't change. The generic site
settings path refuses this setting (server/conat/api/system.ts).

After commit the new value goes to the other bays through the usual site
settings propagation, which sends the gate (and only the gate) through its
own replication service (conat/inter-bay/federated-gate.ts): a bay accepts it
only from the seed bay, as authenticated by the transport. The generic
inter-bay setServerSetting refuses the gate on every bay. A bay that misses
an update is fixed by the next settings sync from the seed.
*/

import type { AuthenticatedCaller } from "@cocalc/conat/core/client";
import getPool from "@cocalc/database/pool";
import { resetServerSettingsCache } from "@cocalc/database/settings/server-settings";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getConfiguredClusterId,
  getConfiguredClusterSeedBayId,
} from "@cocalc/server/cluster-config";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import {
  canonicalFederatedSetting,
  FEDERATED_BROKER_SIGNER_SETTING,
  FEDERATED_CLI_CONNECTORS,
  FEDERATED_GATE_SETTING,
  FEDERATED_ISSUER_PINS_SETTING,
  isFederatedProtectedSetting,
  parseFederatedGate,
  type FederatedCliConnector,
  type FederatedProtectedSetting,
} from "@cocalc/util/ai/federated-connectors";
import { recordFederatedAccessAudit } from "./audit";

const AUDIT_ACTION: Record<
  FederatedProtectedSetting,
  "site-gate-change" | "broker-signer-change" | "issuer-pin-change"
> = {
  [FEDERATED_GATE_SETTING]: "site-gate-change",
  [FEDERATED_BROKER_SIGNER_SETTING]: "broker-signer-change",
  [FEDERATED_ISSUER_PINS_SETTING]: "issuer-pin-change",
};

/**
 * Changes one protected setting (the gate, the broker signer record or the
 * issuer key pins) on the seed: an admin with fresh authentication, in one
 * transaction with its audit row (own action per setting), then replicated
 * to the other bays through the seed-only replica service.
 */
export async function setFederatedProtectedSettingOnSeed({
  account_id,
  session_hash,
  name,
  value,
}: {
  account_id?: string;
  session_hash?: string;
  name: string;
  value: string;
}): Promise<{ value: string }> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("only an admin can change this federated connector setting");
  }
  if (getConfiguredBayId() !== getConfiguredClusterSeedBayId()) {
    throw Error("federated connector settings are changed on the seed bay");
  }
  if (!isFederatedProtectedSetting(name)) {
    throw Error("not a protected federated connector setting");
  }
  const after = canonicalFederatedSetting(name, value);
  if (after == null) throw Error("invalid value");
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
      name,
    ]);
    if (rows[0]?.readonly) {
      throw Error("this setting is set by configuration");
    }
    const before = canonicalFederatedSetting(name, rows[0]?.value ?? "") ?? "";
    if (before === after) throw Error("nothing to change");
    await client.query(
      `INSERT INTO server_settings (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value`,
      [name, after],
    );
    await recordFederatedAccessAudit(client, {
      action: AUDIT_ACTION[name],
      actor_account_id: account_id,
      session,
      before: auditValue(name, before),
      after: auditValue(name, after),
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
  const version = await recordGlobalConfigEventOnSeed({
    scope: SERVER_SETTINGS_CONFIG_SCOPE,
    account_id,
    changes: { settings: [name] },
  });
  await propagateSiteSettingsToBays([{ name, value: after }], {
    scope: SERVER_SETTINGS_CONFIG_SCOPE,
    version,
  });
  return { value: after };
}

function auditValue(name: FederatedProtectedSetting, value: string) {
  if (name === FEDERATED_GATE_SETTING) {
    return { connectors: value === "" ? [] : value.split(",") };
  }
  if (name === FEDERATED_ISSUER_PINS_SETTING) {
    return { pins: value === "" ? [] : value.split(",") };
  }
  const [email, unique_id] = value === "" ? [null, null] : value.split(" ");
  return { signer: email, signer_unique_id: unique_id };
}

/** The gate (G4a API): a protected setting with a list value. */
export async function setFederatedConnectorGateOnSeed({
  account_id,
  session_hash,
  connectors,
}: {
  account_id?: string;
  session_hash?: string;
  connectors: string[];
}): Promise<{ connectors: FederatedCliConnector[] }> {
  if (
    !Array.isArray(connectors) ||
    connectors.some(
      (c) => !(FEDERATED_CLI_CONNECTORS as readonly string[]).includes(c),
    )
  ) {
    throw Error("unknown federated connector");
  }
  const { value } = await setFederatedProtectedSettingOnSeed({
    account_id,
    session_hash,
    name: FEDERATED_GATE_SETTING,
    value: connectors.join(","),
  });
  return { connectors: parseFederatedGate(value) };
}

/**
 * A bay's side of protected-setting replication: accepts a value only from
 * the seed bay of this cluster, as authenticated by the transport (the
 * caller comes from the conat server, never from the request), only for a
 * protected setting and only in canonical form.
 */
export async function applyFederatedGateReplica(
  opts: { name?: string; value: string },
  caller: AuthenticatedCaller | undefined,
): Promise<void> {
  const seed = getConfiguredClusterSeedBayId();
  if (
    !caller?.bay_id ||
    !caller.bay_credential_id ||
    caller.cluster_id !== getConfiguredClusterId() ||
    caller.bay_id !== seed
  ) {
    throw Error(
      "federated connector gate replication must come from the seed bay",
    );
  }
  if (getConfiguredBayId() === seed) {
    throw Error("the seed bay doesn't accept gate replication");
  }
  // Older seeds send only the gate's value.
  const name = opts?.name ?? FEDERATED_GATE_SETTING;
  if (!isFederatedProtectedSetting(name)) {
    throw Error("invalid federated connector gate value");
  }
  const value = typeof opts?.value === "string" ? opts.value : undefined;
  if (value == null || canonicalFederatedSetting(name, value) !== value) {
    throw Error("invalid federated connector gate value");
  }
  await getPool().query(
    `INSERT INTO server_settings (name, value) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value`,
    [name, value],
  );
  resetServerSettingsCache();
}
