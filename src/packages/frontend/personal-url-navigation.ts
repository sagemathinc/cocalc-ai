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
import { load_target, replace_url } from "./history";

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
  return targetDestination(result.target, result.rest);
}

function targetDestination(target: PersonalUrlTarget, rest?: string): string {
  switch (target.kind) {
    case "project":
      return rest
        ? `projects/${target.project_id}/${rest}`
        : `projects/${target.project_id}`;
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
  const requestedUrl = location.href;
  let destination: string | null = null;
  let canonicalPath: string | undefined;
  try {
    const result = await webapp_client.conat_client.hub.personalUrls.resolveUrl(
      { url },
    );
    const accountId = redux.getStore("account")?.get("account_id");
    destination = personalUrlDestination(result, accountId);
    if (
      accountId &&
      result.status === "resolved" &&
      result.owner.account_id === accountId &&
      (result.target?.kind === "agent" || result.target?.kind === "artifact")
    ) {
      canonicalPath = result.canonical_path;
    }
  } catch (err) {
    if (location.href !== requestedUrl) return;
    alert_message({ type: "error", message: `${url}: ${err}` });
  }
  // Back or another navigation may finish before the hub lookup does.
  if (location.href !== requestedUrl) return;
  if (destination == null) {
    alert_message({
      type: "warning",
      message: `Nothing at ${url} is available to you.`,
    });
    replace_url("/people");
    redux.getActions("page").set_active_tab("people", false);
    return;
  }
  // Replace /u/... with the canonical address of what it opened.
  replace_url(canonicalPath ?? `/${destination}`);
  load_target(destination, false, false);
}
