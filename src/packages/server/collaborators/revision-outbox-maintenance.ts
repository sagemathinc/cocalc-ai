/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { readCollaborationRevisionOutboxPage } from "@cocalc/database/postgres/collaborators/collaborators-revision-outbox";
import type { RevisionOutboxCursor } from "@cocalc/database/postgres/collaborators/collaborators-revision-outbox";
import { demandSchedulingEnabled } from "@cocalc/database/postgres/collaborators/collaborators-demand";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { dispatchRevisionOutboxPage } from "./revision-outbox";
import { indexingWork } from "./indexing-metrics";

let cursor: RevisionOutboxCursor | undefined;
let running = false;

/** One bounded scheduling pass. No timer or schema installation here.
 * The process cursor is disposable: durable claims/recipient cursors retain work.
 */
export async function runRevisionOutboxMaintenance(): Promise<number> {
  if (
    running ||
    !demandSchedulingEnabled() ||
    process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE !== "1" ||
    process.env.COCALC_PEOPLE_REVISION_OUTBOX_PROTOTYPE !== "1"
  )
    return 0;
  running = true;
  try {
    if (!(await getServerSettings()).collaborators_enabled) return 0;
    const deadline = performance.now() + 5000;
    const page = await readCollaborationRevisionOutboxPage(
      getConfiguredBayId(),
      cursor,
    );
    let examined = 0,
      attempted = 0;
    for (const candidate of page.candidates) {
      if (performance.now() >= deadline) break;
      cursor = candidate.cursor;
      examined++;
      if (!candidate.eligible) continue;
      attempted++;
      try {
        const result = await dispatchRevisionOutboxPage(
          candidate.cursor.project_id,
        );
        indexingWork.inc({ kind: `revision_outbox_${result.state}` });
      } catch {
        indexingWork.inc({ kind: "revision_outbox_failed" });
      }
      // One project page (at most eight deliveries) per pass. A failing project
      // cannot monopolize the next pass; traversal wraps to retry it later.
      break;
    }
    if (examined === page.candidates.length && page.complete)
      cursor = undefined;
    indexingWork.inc({ kind: "revision_outbox_candidates_examined" }, examined);
    return attempted;
  } finally {
    running = false;
  }
}
