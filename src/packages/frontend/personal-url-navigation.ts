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
): string | null {
  if (result.status === "access-denied") {
    // The project page offers the normal access request.
    return result.project_id ? `projects/${result.project_id}` : null;
  }
  if (result.status !== "resolved" || result.target == null) return null;
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
      return `library/${encodeURIComponent(target.project_id)}/${target.entry_id
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
    destination = personalUrlDestination(result);
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
