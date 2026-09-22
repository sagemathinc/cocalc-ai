/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import callHub from "@cocalc/conat/hub/call-hub";
import { resolveNamedAgentHost } from "@cocalc/chat-client/named-agents";
import type { CodexUsageStatusInfo } from "@cocalc/conat/hub/api/system";
import { openProjectHost, type SiteSession } from "./site-session";

// The hub endpoint is only a placeholder. Model discovery runs beside Codex
// on the project host, just as it does in the browser's routed hub API.
export async function getProjectCodexModels(
  session: SiteSession,
  project: string,
  credentialId?: string,
): Promise<CodexUsageStatusInfo> {
  const host = await resolveNamedAgentHost(
    session.hubApi,
    session.profile.account_id,
    project,
  );
  const lease = await openProjectHost(session, {
    project_id: project,
    host_id: host,
  });
  return (await callHub({
    client: lease.client,
    account_id: session.profile.account_id,
    name: "projects.getCodexUsageStatus",
    args: [
      {
        project_id: project,
        include_models: true,
        credential_id: credentialId,
        timeout: 90000,
      },
    ],
    timeout: 90000,
  })) as CodexUsageStatusInfo;
}
