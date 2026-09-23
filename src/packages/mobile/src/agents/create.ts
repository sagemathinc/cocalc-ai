/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { HeadlessChatClient } from "@cocalc/chat-client";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import type { FilesystemClient } from "@cocalc/conat/files/fs";
import { normalizeAgentName } from "@cocalc/conat/agents/personal";
import { DEFAULT_CODEX_MODEL_NAME } from "@cocalc/util/ai/codex";

export interface PendingAgentCreation {
  projectId: string;
  path: string;
  threadId: string;
}

export async function createNamedAgent({
  agentApi,
  files,
  chat,
  pending,
  name,
  description,
  projectTitle,
  workingDirectory,
}: {
  agentApi: Pick<
    AgentApi,
    "resolveIdentity" | "registerIdentity" | "nameAgent"
  >;
  files: Pick<FilesystemClient, "exists" | "mkdir" | "stat" | "writeFile">;
  chat: Pick<HeadlessChatClient, "createCodexThread">;
  pending: PendingAgentCreation;
  name: string;
  description: string;
  projectTitle: string;
  workingDirectory: string;
}) {
  const normalizedName = normalizeAgentName(name);
  const directory = workingDirectory.trim();
  if (!directory.startsWith("/")) {
    throw new Error("Choose an absolute working directory in this project.");
  }
  const locator = {
    project_id: pending.projectId,
    path: pending.path,
    thread_id: pending.threadId,
  };
  let identity = await agentApi.resolveIdentity(locator);
  if (!identity) {
    let stat;
    try {
      stat = await files.stat(directory);
    } catch {
      throw new Error(
        `Working directory ${JSON.stringify(directory)} does not exist.`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `Working directory ${JSON.stringify(directory)} is not a directory.`,
      );
    }
    const parent = pending.path.slice(0, pending.path.lastIndexOf("/"));
    await files.mkdir(parent, { recursive: true });
    if (!(await files.exists(pending.path))) {
      await files.writeFile(pending.path, "");
    }
    try {
      await chat.createCodexThread({
        thread_id: pending.threadId,
        name: name.trim(),
        acp_config: {
          model: DEFAULT_CODEX_MODEL_NAME,
          paymentSource: "auto",
          sessionMode: "auto",
          allowWrite: true,
          workingDirectory: directory,
        },
      });
    } catch (err) {
      // This private path and thread id are retained across manual retries.
      if (!String(err).includes(`thread '${pending.threadId}' already exists`))
        throw err;
    }
    identity = await agentApi.registerIdentity(locator);
  }
  await agentApi.nameAgent({
    endpoint: { project_id: pending.projectId, agent_id: identity.agent_id },
    name: normalizedName,
    description: description.trim(),
    project_title: projectTitle,
    thread_title: name.trim(),
  });
  return identity;
}
