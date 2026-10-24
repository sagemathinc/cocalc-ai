/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import getLogger from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import {
  expireAbandonedSiteFundedCodexReservations,
  reconcileTerminalSiteFundedCodexReservations,
} from "./site-funded-codex-reservations";
import { pruneSiteFundedAdmissions } from "./site-funded-admissions";

const logger = getLogger("server:ai:site-funded-codex-maintenance");
const INTERVAL_MS = 60_000;
let started = false;

export function startSiteFundedCodexMaintenance(): void {
  if (started || getConfiguredBayId() !== getConfiguredClusterSeedBayId()) {
    return;
  }
  started = true;
  const run = async () => {
    try {
      const expired = await expireAbandonedSiteFundedCodexReservations();
      if (expired > 0) {
        logger.info("expired abandoned site-funded Codex reservations", {
          expired,
        });
      }
      const reconciled = await reconcileTerminalSiteFundedCodexReservations();
      if (reconciled > 0) {
        logger.info("reconciled terminal site-funded Codex reservations", {
          reconciled,
        });
      }
      await pruneSiteFundedAdmissions();
    } catch (err) {
      logger.warn("site-funded Codex maintenance failed", { err: `${err}` });
    }
  };
  void run();
  const timer = setInterval(() => void run(), INTERVAL_MS);
  timer.unref();
}
