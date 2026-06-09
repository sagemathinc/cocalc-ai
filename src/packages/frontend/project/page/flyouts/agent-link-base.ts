/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AgentSessionRecord } from "@cocalc/frontend/chat/agent-session-index";
import { joinAbsolutePath } from "@cocalc/util/path-model";

export function agentSessionMarkdownLinkBasePath(
  record?: Pick<AgentSessionRecord, "chat_path" | "working_directory"> | null,
  metadata?: {
    acp_config?: { workingDirectory?: string } | null;
  } | null,
): string | undefined {
  if (!record?.chat_path) return undefined;
  const workingDirectory =
    typeof metadata?.acp_config?.workingDirectory === "string" &&
    metadata.acp_config.workingDirectory.trim()
      ? metadata.acp_config.workingDirectory.trim()
      : typeof record.working_directory === "string" &&
          record.working_directory.trim()
        ? record.working_directory.trim()
        : undefined;
  if (!workingDirectory) return record.chat_path;
  return joinAbsolutePath(workingDirectory, ".cocalc-agent-links");
}
