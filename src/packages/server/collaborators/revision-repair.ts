/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { readCollaborationRevisionDispatchPage } from "@cocalc/database/postgres/collaborators/collaborators-revision-interest";
import type { RevisionDispatchCursor } from "@cocalc/database/postgres/collaborators/collaborators-revision-interest";
import { demandSchedulingEnabled } from "@cocalc/database/postgres/collaborators/collaborators-demand";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { dispatchCollaborationRevisionHint } from "./revision-dispatch";
import { indexingWork } from "./indexing-metrics";

let cursor: RevisionDispatchCursor | undefined;
let running = false;

/** Repair only: durable claims survive unknown outcomes; restarting the cursor
 * may revisit rows but cannot acknowledge undelivered hints.
 */
export async function runRevisionHintRepair() {
  if (
    running ||
    !demandSchedulingEnabled() ||
    process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE !== "1"
  )
    return 0;
  running = true;
  let attempted = 0;
  try {
    if (!(await getServerSettings()).collaborators_enabled) return 0;
    const deadline = performance.now() + 5000;
    const page = await readCollaborationRevisionDispatchPage(
      getConfiguredBayId(),
      cursor,
    );
    let examined = 0;
    for (const row of page.candidates) {
      if (attempted >= 8 || performance.now() >= deadline) break;
      if (row.pending) {
        attempted++;
        try {
          const result = await dispatchCollaborationRevisionHint(row);
          indexingWork.inc({ kind: `revision_hint_${result.state}` });
        } catch {
          indexingWork.inc({ kind: "revision_hint_failed" });
        }
      }
      cursor = { project_id: row.project_id, home_bay_id: row.home_bay_id };
      examined++;
    }
    if (examined === page.candidates.length && page.complete)
      cursor = undefined;
    indexingWork.inc({ kind: "revision_hint_candidates_examined" }, examined);
    return attempted;
  } finally {
    running = false;
  }
}
