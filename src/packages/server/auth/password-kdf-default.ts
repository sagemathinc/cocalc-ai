/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Choose password_kdf once, when it has never been set.

"legacy" exists only so a deployment that already has password hashes can
roll back to a release that cannot verify scrypt (the two-phase rollout). A
fresh install has no hashes and no older release to roll back to, so it
starts on "scrypt". The choice is persisted, so a later upgrade never flips
it; an explicit value (admin or environment) is never changed.

Only the seed bay decides: the setting is seed-global and propagated from
there. Freshness is measured before startup creates any account (e.g. the
on-prem admin), so that account does not make a fresh install look old.
*/

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { resetServerSettingsCache } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";

const log = getLogger("server:auth:password-kdf-default");

/** Whether this database holds no password or recovery-code hash yet. */
export async function hasNoPasswordHashes(): Promise<boolean> {
  const { rows } = await getPool().query<{ any: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM accounts
                     WHERE password_hash IS NOT NULL AND password_hash <> '')
         OR EXISTS (SELECT 1 FROM account_second_factor_recovery_codes) AS any`,
  );
  return rows[0]?.any !== true;
}

/**
 * Persist password_kdf if it is unset: "scrypt" for a fresh install,
 * "legacy" otherwise. Returns the value now stored, or undefined when this
 * is not the seed bay.
 */
export async function initPasswordKdfDefault({
  fresh,
}: {
  fresh: boolean;
}): Promise<string | undefined> {
  if (getConfiguredBayId() !== getConfiguredClusterSeedBayId()) return;
  const value = fresh ? "scrypt" : "legacy";
  // Atomic: concurrent hub workers, or a value set meanwhile, win.
  const { rows } = await getPool().query<{ value: string }>(
    `INSERT INTO server_settings (name, value) VALUES ('password_kdf', $1)
     ON CONFLICT (name) DO NOTHING RETURNING value`,
    [value],
  );
  if (rows.length > 0) {
    resetServerSettingsCache();
    log.info(
      fresh
        ? "password_kdf was unset on a fresh install: persisted 'scrypt'"
        : "password_kdf was unset on a deployment with password hashes: persisted 'legacy' (switch to 'scrypt' deliberately, see the setting)",
    );
    return value;
  }
  const current = await getPool().query<{ value: string }>(
    "SELECT value FROM server_settings WHERE name = 'password_kdf'",
  );
  return current.rows[0]?.value;
}
