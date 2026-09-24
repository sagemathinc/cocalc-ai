/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getProjectRecoveryHealth } from "./maintenance-status";
import { recordProjectRecoveryCoverageSlot } from "./recovery-objectives";

const logger = getLogger("server:projects:recovery-coverage");
const CHECK_INTERVAL_MS = 5 * 60_000;

let timer: NodeJS.Timeout | undefined;
let running = false;
let lastPrunedDay: string | undefined;

export async function runProjectRecoveryCoverageCheck(
  checkedAt = new Date(),
): Promise<string> {
  const health = await getProjectRecoveryHealth();
  const slotStart = await recordProjectRecoveryCoverageSlot({
    health,
    checkedAt,
  });
  const day = checkedAt.toISOString().slice(0, 10);
  if (lastPrunedDay !== day) {
    await getPool().query(
      `DELETE FROM project_recovery_coverage_slots
        WHERE slot_start < NOW() - INTERVAL '40 days'`,
    );
    lastPrunedDay = day;
  }
  return slotStart;
}

export function startProjectRecoveryCoverageMaintenance(): void {
  if (timer) return;
  const run = () => {
    if (running) return;
    running = true;
    void runProjectRecoveryCoverageCheck()
      .catch((err) =>
        logger.warn("project recovery coverage audit failed", {
          err: `${err}`,
        }),
      )
      .finally(() => {
        running = false;
      });
  };
  timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref?.();
  setTimeout(run, 60_000).unref?.();
}
