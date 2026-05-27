/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CodexThreadConfig } from "@cocalc/chat";
import type { ChatActions } from "./actions";
import type { NewThreadSetup } from "./chatroom-thread-panel";
import {
  DEFAULT_CODEX_MODEL_NAME,
  isCodexModelName,
  resolveCodexSessionMode,
} from "@cocalc/util/ai/codex";

type GitCommitAgentTurnOptions = {
  actions: ChatActions;
  prompt: string;
  targetThreadKey?: string | null;
  parentMessageId?: string;
  defaultNewThreadSetup: NewThreadSetup;
  workingDirectory?: string;
  title?: string;
};

type GitCommitAgentTurnResult = {
  mode: "existing" | "created";
  threadKey?: string;
  timestamp?: string;
};

function field<T = unknown>(value: unknown, key: string): T | undefined {
  if (value == null) return undefined;
  if (typeof (value as any)?.get === "function") {
    return (value as any).get(key) as T | undefined;
  }
  return (value as any)?.[key] as T | undefined;
}

function normalizeThreadKey(value?: string | null): string | undefined {
  const key = `${value ?? ""}`.trim();
  return key || undefined;
}

function normalizeWorkingDirectory(value?: string): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  return trimmed || undefined;
}

function normalizeOptionalString(value?: string): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  return trimmed || undefined;
}

function threadSupportsCodex(
  metadata?: {
    agent_kind?: string | null;
    agent_model?: string | null;
    acp_config?: Partial<CodexThreadConfig> | null;
  } | null,
): boolean {
  if (!metadata) return false;
  if (metadata.agent_kind === "acp" || metadata.acp_config != null) {
    return true;
  }
  return isCodexModelName(`${metadata.agent_model ?? ""}`.trim());
}

function latestMessageIdInThread(
  actions: ChatActions,
  threadId: string,
): string | undefined {
  const messages = actions.getMessagesInThread(threadId) ?? [];
  return (
    `${field(messages[messages.length - 1], "message_id") ?? ""}`.trim() ||
    undefined
  );
}

function buildCodexConfig({
  setup,
  workingDirectory,
}: {
  setup: NewThreadSetup;
  workingDirectory?: string;
}): CodexThreadConfig {
  const model =
    setup.codexConfig.model?.trim() ||
    setup.model?.trim() ||
    DEFAULT_CODEX_MODEL_NAME;
  const config: Partial<CodexThreadConfig> = {
    ...setup.codexConfig,
    model,
  };
  const wd = normalizeWorkingDirectory(workingDirectory);
  if (wd) {
    config.workingDirectory = wd;
  }
  const sessionMode = resolveCodexSessionMode(config as CodexThreadConfig);
  config.sessionMode = sessionMode;
  config.allowWrite = sessionMode !== "read-only";
  return config as CodexThreadConfig;
}

export function sendGitCommitAgentTurn({
  actions,
  prompt,
  targetThreadKey,
  parentMessageId,
  defaultNewThreadSetup,
  workingDirectory,
  title,
}: GitCommitAgentTurnOptions): GitCommitAgentTurnResult {
  const trimmed = `${prompt ?? ""}`.trim();
  if (!trimmed) {
    return { mode: "existing" };
  }

  const threadId = normalizeThreadKey(targetThreadKey);
  const metadata = threadId
    ? actions.getThreadMetadata?.(threadId, { threadId })
    : undefined;
  if (threadId && threadSupportsCodex(metadata as any)) {
    const timestamp = actions.sendChat({
      extraInput: trimmed,
      reply_thread_id: threadId,
      parent_message_id:
        parentMessageId ?? latestMessageIdInThread(actions, threadId),
      preserveSelectedThread: true,
    });
    return { mode: "existing", threadKey: threadId, timestamp };
  }

  const setup = defaultNewThreadSetup;
  const codexConfig = buildCodexConfig({ setup, workingDirectory });
  const timestamp = actions.sendChat({
    extraInput: trimmed,
    name: title?.trim() || setup.title.trim() || undefined,
    threadAgent: {
      mode: "codex",
      model: codexConfig.model,
      codexConfig,
    },
    threadAppearance: {
      color: normalizeOptionalString(setup.color),
      icon: normalizeOptionalString(setup.icon),
      image: normalizeOptionalString(setup.image),
    },
  });
  const created = timestamp
    ? actions.getMessageByDate(new Date(timestamp))
    : undefined;
  return {
    mode: "created",
    threadKey: field<string>(created, "thread_id"),
    timestamp,
  };
}
