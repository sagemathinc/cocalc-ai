/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  claimCollaborationRevisionOutbox,
  settleCollaborationRevisionOutbox,
} from "@cocalc/database/postgres/collaborators/collaborators-revision-outbox";
import { readCollaborationRevisionFanoutPage } from "@cocalc/database/postgres/collaborators/collaborators-revision-interest";
import { demandSchedulingEnabled } from "@cocalc/database/postgres/collaborators/collaborators-demand";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { dispatchCollaborationRevisionHint } from "./revision-dispatch";

/** Explicit internal page dispatch, not a public endpoint or background timer.
 * A retained page may revisit acknowledged interests, which the reader excludes.
 * Only durable destination acceptance permits settling the claimed outbox page.
 */
export async function dispatchRevisionOutboxPage(project_id: string) {
  let attempted = 0,
    acknowledged = 0;
  if (
    !demandSchedulingEnabled() ||
    process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE !== "1" ||
    process.env.COCALC_PEOPLE_REVISION_OUTBOX_PROTOTYPE !== "1" ||
    !(await getServerSettings()).collaborators_enabled
  )
    return { state: "disabled" as const, attempted, acknowledged };
  const authority = { owning_bay_id: getConfiguredBayId() };
  const claim = await claimCollaborationRevisionOutbox(project_id, authority);
  if (!claim) return { state: "idle" as const, attempted, acknowledged };
  const deadline = performance.now() + 5000;
  const page = await readCollaborationRevisionFanoutPage(
    {
      project_id,
      ...(claim.after_home_bay === null
        ? {}
        : { after_home_bay_id: claim.after_home_bay }),
    },
    authority,
  );
  let handled = true;
  for (const hint of page.hints) {
    if (attempted >= 8 || performance.now() >= deadline) {
      handled = false;
      break;
    }
    attempted++;
    try {
      const result = await dispatchCollaborationRevisionHint(hint);
      if (result.state === "acknowledged") acknowledged++;
      else handled = false;
    } catch {
      // An unknown RPC outcome is not proof of rejection or safe page progress.
      handled = false;
    }
  }
  if (!handled) return { state: "retained" as const, attempted, acknowledged };
  const settled = await settleCollaborationRevisionOutbox(
    claim,
    page.next_after,
    authority,
  );
  return {
    state: settled ? ("advanced" as const) : ("superseded" as const),
    attempted,
    acknowledged,
  };
}
