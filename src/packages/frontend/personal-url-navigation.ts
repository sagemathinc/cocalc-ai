/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// /u/<owner>/<kind>/<alias> resolves through the hub, then opens the target
// with the same navigation a click inside the app would use.

import { alert_message } from "@cocalc/frontend/alerts";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  PersonalUrlTarget,
  ResolvedPersonalUrl,
} from "@cocalc/util/personal-urls";
import { load_target } from "./history";

export function personalUrlDestination(
  result: ResolvedPersonalUrl,
  myAccountId?: string,
): string | null {
  if (result.status === "access-denied") {
    // The project page offers the normal access request.
    return result.project_id ? `projects/${result.project_id}` : null;
  }
  if (result.status !== "resolved" || result.target == null) return null;
  // My own named agent or artifact opens by name, so its address keeps the
  // readable /u/<me>/... form instead of becoming an id.
  if (myAccountId && result.owner.account_id === myAccountId) {
    if (result.target.kind === "agent")
      return `agents/${encodeURIComponent(result.alias)}`;
    if (result.target.kind === "artifact")
      return `artifacts/${encodeURIComponent(result.alias)}`;
  }
  return targetDestination(result.target);
}

function targetDestination(target: PersonalUrlTarget): string {
  switch (target.kind) {
    case "conversation":
      return `people/conversations/${target.project_id}/${target.conversation_id}`;
    case "person":
      return `people/collaborators/${target.person_id}`;
    case "agent":
      return `agents/${encodeURIComponent(target.agent_id)}`;
    case "artifact":
      return `artifacts/${encodeURIComponent(target.project_id)}/${target.entry_id
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
  }
}

export async function openPersonalUrl(path: string): Promise<void> {
  const url = path.startsWith("/") ? path : `/${path}`;
  let destination: string | null = null;
  try {
    const result = await webapp_client.conat_client.hub.personalUrls.resolveUrl(
      { url },
    );
    destination = personalUrlDestination(
      result,
      redux.getStore("account")?.get("account_id"),
    );
  } catch (err) {
    alert_message({ type: "error", message: `${url}: ${err}` });
  }
  if (destination == null) {
    alert_message({
      type: "warning",
      message: `Nothing at ${url} is available to you.`,
    });
    redux.getActions("page").set_active_tab("people");
    return;
  }
  // Replace /u/... with the canonical address of what it opened.
  load_target(destination, false, true);
}
