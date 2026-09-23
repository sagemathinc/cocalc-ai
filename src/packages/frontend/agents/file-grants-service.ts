/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { AgentFileGrant } from "@cocalc/conat/agents/file-grants";
import { redux } from "@cocalc/frontend/app-framework";

function assertCurrentAccount(accountId: string): void {
  if (redux.getStore("account")?.get("account_id") !== accountId) {
    throw new Error("Account changed. Reopen file grants.");
  }
}

export async function fileGrantsForAgent({
  projectId,
  path,
  threadId,
}: {
  projectId: string;
  path: string;
  threadId: string;
}): Promise<{ agentId?: string; grants: AgentFileGrant[] }> {
  const identity = await webapp_client.conat_client.hub.agent.resolveIdentity({
    project_id: projectId,
    path,
    thread_id: threadId,
  });
  if (!identity) return { grants: [] };
  return {
    agentId: identity.agent_id,
    grants: await webapp_client.conat_client.hub.agent.listFileGrants({
      project_id: projectId,
      agent_id: identity.agent_id,
    }),
  };
}

export async function contextForFileGrants({
  accountId,
  projectId,
  path,
  threadId,
}: {
  accountId: string;
  projectId: string;
  path: string;
  threadId: string;
}): Promise<string> {
  assertCurrentAccount(accountId);
  const { grants } = await fileGrantsForAgent({ projectId, path, threadId });
  assertCurrentAccount(accountId);
  if (!grants.length) return "";
  return [
    "[User-selected file grants]",
    "These file grants belong to the user sending this turn and are valid only while this agent run remains active. Writes persist after the run ends.",
    "Use the identity-only CoCalc CLI commands below. They never fall back to account or project credentials:",
    ...grants.flatMap((grant) => [
      `- Target project ${grant.target_project_id}; permission: ${grant.mode ?? "read"}; roots: ${grant.roots
        .map((root) => root || ".")
        .join(", ")}`,
      `  - list: cocalc project file grant list --project ${grant.target_project_id} [path]`,
      `  - read text: cocalc project file grant cat --project ${grant.target_project_id} <path>`,
      `  - download: cocalc project file grant get --project ${grant.target_project_id} <path> <dest>`,
      ...(grant.mode === "read-write"
        ? [
            `  - upload/overwrite: cocalc project file grant put --project ${grant.target_project_id} <local-file> <path>`,
            `  - create directory: cocalc project file grant mkdir --project ${grant.target_project_id} <path> [--parents]`,
            `  - rename: cocalc project file grant rename --project ${grant.target_project_id} <source> <dest>`,
            `  - copy file: cocalc project file grant copy --project ${grant.target_project_id} <source> <dest>`,
            `  - remove: cocalc project file grant rm --project ${grant.target_project_id} <path> [--recursive]`,
            "  Writes through symlinks are not supported. Do not bypass denied paths with other credentials.",
          ]
        : []),
    ]),
    "Do not infer access to any unlisted project or path.",
    "[/User-selected file grants]",
  ].join("\n");
}
