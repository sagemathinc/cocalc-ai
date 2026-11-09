/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A site setting sent by another bay through the generic BayOps
// setServerSetting. The federated connector gate is refused here on every
// bay: it is replicated only through its own seed-authenticated service
// (server/federated-connectors/site-gate.ts).

import { db } from "@cocalc/database";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { FEDERATED_GATE_SETTING } from "@cocalc/util/ai/federated-connectors";
import { callback2 } from "@cocalc/util/async-utils";

export async function applyServerSettingFromBay(
  bay_id: string,
  opts: { name: string; value: string },
  isSeedOnlySiteSetting: (name: string) => boolean,
): Promise<void> {
  if (opts?.name === FEDERATED_GATE_SETTING) {
    throw Error(`setting '${opts.name}' is replicated only from the seed`);
  }
  if (
    bay_id !== getConfiguredClusterSeedBayId() &&
    isSeedOnlySiteSetting(opts.name)
  ) {
    throw Error(`setting '${opts.name}' is seed-only`);
  }
  await callback2(db().set_server_setting, opts);
}
