/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  readCollaborationRevisionReceiverPage,
  readRevisionSchedulingState,
  advanceRevisionScheduling,
} from "@cocalc/database/postgres/collaborators/collaborators-revision-receiver";
import {
  readCollaborationProjectDemandPage,
  scheduleCollaborationRevisionDemand,
} from "@cocalc/database/postgres/collaborators/collaborators-demand";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { indexingWork } from "./indexing-metrics";

let after_project_id: string | undefined;
let running = false;

/** Schedule at most one twenty-account page per pass. Durable per-receiver
 * cursors survive restart; the process cursor only supplies project fairness.
 */
export async function runRevisionWakeupScheduling(): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    if (!(await getServerSettings()).collaborators_enabled) return 0;
    const home_bay_id = getConfiguredBayId();
    const deadline = performance.now() + 5000;
    const receivers = await readCollaborationRevisionReceiverPage({
      home_bay_id,
      after_project_id,
    });
    for (const receiver of receivers.pending) {
      if (performance.now() >= deadline) return 0;
      after_project_id = receiver.project_id;
      const state = await readRevisionSchedulingState(
        receiver.project_id,
        home_bay_id,
      );
      if (!state || state.complete) continue;
      const page = await readCollaborationProjectDemandPage({
        project_id: state.project_id,
        home_bay_id,
        after: state.after ?? undefined,
      });
      let ready = true;
      let scheduled = 0;
      for (const account_id of page.account_ids) {
        if (performance.now() >= deadline) {
          ready = false;
          break;
        }
        try {
          const result = await scheduleCollaborationRevisionDemand(
            account_id,
            state.project_id,
          );
          if (result === "busy") ready = false;
          if (result === "scheduled") scheduled++;
        } catch {
          ready = false;
          indexingWork.inc({ kind: "revision_wakeup_schedule_failed" });
        }
      }
      if (ready) {
        const advanced = await advanceRevisionScheduling(
          state,
          page.next_after,
        );
        indexingWork.inc({
          kind: advanced
            ? "revision_wakeup_page_scheduled"
            : "revision_wakeup_page_superseded",
        });
      }
      indexingWork.inc(
        { kind: "revision_wakeup_accounts_scheduled" },
        scheduled,
      );
      return scheduled;
    }
    after_project_id = receivers.next_after ?? undefined;
    return 0;
  } finally {
    running = false;
  }
}
