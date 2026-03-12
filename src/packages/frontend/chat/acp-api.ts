import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  AcpAutomationConfig,
  AcpAutomationResponse,
  AcpChatContext,
  AcpLoopConfig,
  AcpLoopState,
} from "@cocalc/conat/ai/acp/types";
import {
  DEFAULT_CODEX_MODEL_NAME,
  DEFAULT_CODEX_MODELS,
  resolveCodexSessionMode,
  type CodexSessionConfig,
} from "@cocalc/util/ai/codex";
import { uuid } from "@cocalc/util/misc";
import type { ChatMessage } from "./types";
import type { CodexThreadConfig } from "@cocalc/chat";
import { dateValue, field } from "./access";
import { type ChatActions } from "./actions";

let lastGeneratedAcpMessageMs = 0;
const ACP_ACK_TIMEOUT_MS = 2 * 60 * 1000;
const ACP_ACK_MAX_ATTEMPTS = 5;
const ACP_ACK_BACKOFF_MS = 2000;

export function resetAcpApiStateForTests(): void {
  lastGeneratedAcpMessageMs = 0;
}

function isRetryableAcpAckError(err: unknown): boolean {
  const message = `${err ?? ""}`.toLowerCase();
  return (
    message.includes("without acknowledgement") ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

async function waitForAcpRetryDelay(attempt: number): Promise<void> {
  const delayMs = Math.min(
    30_000,
    ACP_ACK_BACKOFF_MS * Math.max(1, 2 ** Math.max(0, attempt - 1)),
  );
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function nextAcpMessageDate({
  actions,
  minMs,
}: {
  actions: ChatActions;
  minMs: number;
}): Date {
  let candidate = Math.max(Date.now(), minMs, lastGeneratedAcpMessageMs + 1);
  let collisions = 0;
  while (
    actions.getMessageByDate?.(candidate) ??
    actions.getAllMessages?.().has(`${candidate}`)
  ) {
    collisions += 1;
    candidate += 1;
  }
  if (collisions > 0) {
    console.warn("ACP message_date collision avoided", {
      minMs,
      collisions,
      candidate,
    });
  }
  lastGeneratedAcpMessageMs = candidate;
  return new Date(candidate);
}

function maybeDecorateLoopPrompt({
  prompt,
  loopConfig,
}: {
  prompt: string;
  loopConfig?: AcpLoopConfig;
}): string {
  if (loopConfig?.enabled !== true) return prompt;
  const maxTurns = Number(loopConfig.max_turns ?? 8);
  const maxWallMinutes = Math.max(
    1,
    Math.round(Number(loopConfig.max_wall_time_ms ?? 30 * 60_000) / 60_000),
  );
  return [
    prompt,
    "",
    "System loop contract (required):",
    `This run is in autonomous loop mode (max turns: ${maxTurns}, max wall time: ${maxWallMinutes} minutes).`,
    "At the END of your response, output exactly one JSON object in a ```json fenced block with this schema:",
    '{"loop":{"rerun":true|false,"needs_human":true|false,"next_prompt":"string","blocker":"string","confidence":0.0-1.0}}',
    "Rules:",
    "- If rerun=true and needs_human=false, set next_prompt to the exact next instruction for the next iteration.",
    "- If done, set rerun=false.",
    "- If human input is needed, set needs_human=true and explain blocker.",
    "- Do not omit the JSON contract block.",
  ].join("\n");
}

// Clear transient frontend-rendered ACP state for a thread. Persisted queue and
// running state is rehydrated from SyncDB, so there is no browser-owned queue
// to reset anymore.
export function resetAcpThreadState({
  actions,
  threadId,
}: {
  actions: ChatActions;
  threadId?: string;
}): void {
  const store = actions.store;
  if (!store) return;

  const normalizedThreadId = `${threadId ?? ""}`.trim();
  const threadMessages = normalizedThreadId
    ? (actions.getMessagesInThread(normalizedThreadId) ?? [])
    : [];
  let nextState = store.get("acpState");
  for (const msg of threadMessages) {
    const messageId = field<string>(msg, "message_id");
    if (messageId) {
      nextState = nextState.delete(`message:${messageId}`);
    }
    const threadId = field<string>(msg, "thread_id");
    if (threadId) {
      nextState = nextState.delete(`thread:${threadId}`);
    }
  }
  store.setState({ acpState: nextState });
}

type ProcessAcpRequest = {
  message: ChatMessage;
  model: string;
  input: string;
  actions: ChatActions;
  sendMode?: "immediate";
  acpConfigOverride?: Partial<CodexThreadConfig>;
};

export async function processAcpLLM({
  message,
  model,
  input,
  actions,
  sendMode,
  acpConfigOverride,
}: ProcessAcpRequest): Promise<void> {
  const { syncdb, store, chatStreams } = actions;
  if (syncdb == null || store == null) return;

  let workingInput = input?.trim();
  if (!workingInput) {
    return;
  }

  const sender_id = model || "openai-codex-agent";

  const messageDate = dateValue(message);
  if (!messageDate) {
    throw Error("invalid message");
  }
  const project_id = store.get("project_id");
  const path = store.get("path");
  const thread_id = `${(message as any)?.thread_id ?? ""}`.trim();
  const user_message_id = (message as any)?.message_id;
  if (!user_message_id) {
    console.warn("ACP turn missing user message_id; skipping", {
      project_id,
      path,
      message_date: messageDate.toISOString(),
    });
    return;
  }
  if (!thread_id) {
    console.warn("ACP turn missing thread_id; skipping", {
      project_id,
      path,
      message_id: user_message_id,
    });
    return;
  }
  const loopConfigFromMessage = field<AcpLoopConfig>(
    message as any,
    "acp_loop_config",
  );
  const loopStateFromMessage = field<AcpLoopState>(
    message as any,
    "acp_loop_state",
  );
  const loopConfig = loopConfigFromMessage;
  const loopState =
    typeof loopStateFromMessage?.loop_id === "string" &&
    loopStateFromMessage.loop_id.trim()
      ? loopStateFromMessage
      : undefined;
  const config = {
    ...(actions.getCodexConfig?.(thread_id) ?? {}),
    ...(acpConfigOverride ?? {}),
  };
  const normalizedModel =
    typeof model === "string" ? normalizeCodexMention(model) : undefined;
  // If thread_config.sessionId has not been persisted yet, recover it from the
  // most recent ACP assistant message in this thread so follow-up turns still
  // resume the same Codex session.
  const inferredSessionId = (() => {
    const threadMessages = actions.getMessagesInThread?.(thread_id) ?? [];
    for (let i = threadMessages.length - 1; i >= 0; i--) {
      const sessionId = field<string>(threadMessages[i], "acp_thread_id");
      if (typeof sessionId === "string" && sessionId.trim().length > 0) {
        return sessionId.trim();
      }
    }
    return undefined;
  })();
  const effectiveSessionId = config.sessionId ?? inferredSessionId;
  // Backend chat writer must own a distinct assistant row for this turn.
  // Reusing the user's message_id can cause backend updates to overwrite the
  // input message history instead of writing assistant output.
  const message_id = uuid();

  const id = uuid();
  chatStreams.add(id);
  // NOTE: the stream is ONLY used to submit the message for acp;
  // the actual resonse is via a pub/sub channel.  Thus this 3 minutes
  // is fine, even if the response is very long.
  setTimeout(() => chatStreams.delete(id), 3 * 60 * 1000);

  const setState = (state) => {
    const messageIdKey = `message:${user_message_id}`;
    let next = store.get("acpState");
    if (state) {
      next = next.set(messageIdKey, state);
    } else {
      next = next.delete(messageIdKey);
    }
    store.setState({
      acpState: next,
    });
  };

  const sessionKey = effectiveSessionId ?? thread_id;
  const promptForRunWithLoop = maybeDecorateLoopPrompt({
    prompt: workingInput,
    loopConfig,
  });
  // Generate a stable assistant-reply key for this turn, but do NOT write any
  // corresponding chat row here. The backend is the sole writer of the assistant
  // reply row (avoids frontend/backend sync races on the same row).
  const newMessageDate = nextAcpMessageDate({
    actions,
    minMs: messageDate.valueOf() + 1,
  });
  const chatMetadata = buildChatMetadata({
    project_id,
    path,
    sender_id,
    api_url:
      typeof window !== "undefined"
        ? `${window.location.protocol}//${window.location.host}`
        : undefined,
    browser_id: webapp_client.browser_id,
    messageDate: newMessageDate,
    thread_id,
    message_id,
    parent_message_id: user_message_id,
    sendMode: sendMode,
    loop_config: loopConfig,
    loop_state: loopState,
  });
  let acknowledged = false;
  try {
    let lastError: unknown;
    for (let attempt = 1; attempt <= ACP_ACK_MAX_ATTEMPTS; attempt += 1) {
      acknowledged = false;
      try {
        setState("sending");
        const stream = await webapp_client.conat_client.streamAcp(
          {
            project_id,
            prompt: promptForRunWithLoop,
            session_id: sessionKey,
            config: buildAcpConfig({
              path,
              config:
                effectiveSessionId != null
                  ? { ...config, sessionId: effectiveSessionId }
                  : config,
              model: normalizedModel,
            }),
            chat: chatMetadata,
          },
          { timeout: ACP_ACK_TIMEOUT_MS },
        );
        for await (const response of stream) {
          if (response?.type === "error") {
            throw Error(response.error);
          }
          if (response?.type !== "status") {
            continue;
          }
          acknowledged = true;
          if (response.state === "queued") {
            setState("queue");
          } else if (response.state === "running") {
            setState("running");
          } else {
            setState("sent");
          }
        }
        if (!acknowledged) {
          throw Error("ACP queue submission ended without acknowledgement");
        }
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        if (attempt >= ACP_ACK_MAX_ATTEMPTS || !isRetryableAcpAckError(err)) {
          throw err;
        }
        try {
          await webapp_client.conat_client.interruptAcp({
            project_id,
            threadId: sessionKey,
            chat: chatMetadata,
            note: `frontend retry after no ACP acknowledgement (attempt ${attempt})`,
          });
        } catch {}
        setState("sending");
        await waitForAcpRetryDelay(attempt);
      }
    }
    if (lastError != null) {
      throw lastError;
    }
  } catch (err) {
    console.error("ACP turn failed", err);
    // Backend owns the assistant reply row, but if we fail before the backend
    // can even enqueue the turn, we still want the user to see *something*.
    try {
      const raw = `${err}`;
      const cleaned = raw.startsWith("Error: Error:")
        ? raw.slice("Error: ".length)
        : raw;
      actions.sendReply({
        message,
        reply: cleaned,
        from: sender_id,
        noNotification: true,
      });
      syncdb.commit();
    } catch (writeErr) {
      console.error("Failed to write ACP error reply", writeErr);
    }
    setState("");
  } finally {
    chatStreams.delete(id);
  }
}

export async function cancelQueuedAcpTurn({
  actions,
  message,
}: {
  actions: ChatActions;
  message: ChatMessage;
}): Promise<boolean> {
  const { store } = actions;
  if (!store) return false;
  const messageId = field<string>(message, "message_id");
  if (!messageId) return false;
  const threadId = field<string>(message, "thread_id");
  if (!threadId) return false;
  const project_id = store.get("project_id");
  const path = store.get("path");
  if (!project_id || !path) return false;
  const result = await webapp_client.conat_client.controlAcp({
    project_id,
    path,
    thread_id: threadId,
    user_message_id: messageId,
    action: "cancel",
  });
  if (!result?.ok) {
    return false;
  }
  store.setState({
    acpState: (store.get("acpState") ?? new Map()).set(
      `message:${messageId}`,
      "not-sent",
    ),
  });
  return true;
}

export async function sendQueuedAcpTurnImmediately({
  actions,
  message,
}: {
  actions: ChatActions;
  message: ChatMessage;
}): Promise<boolean> {
  const { store } = actions;
  if (!store) return false;
  const messageId = field<string>(message, "message_id");
  if (!messageId) return false;
  const threadId = field<string>(message, "thread_id");
  if (!threadId) return false;
  const project_id = store.get("project_id");
  const path = store.get("path");
  if (!project_id || !path) return false;
  const result = await webapp_client.conat_client.controlAcp({
    project_id,
    path,
    thread_id: threadId,
    user_message_id: messageId,
    action: "send_immediately",
  });
  if (!result?.ok) {
    return false;
  }
  store.setState({
    acpState: (store.get("acpState") ?? new Map()).set(
      `message:${messageId}`,
      "sent",
    ),
  });
  return true;
}

async function automationRequest({
  actions,
  threadId,
  action,
  config,
}: {
  actions: ChatActions;
  threadId: string;
  action: "upsert" | "pause" | "resume" | "run_now" | "acknowledge" | "delete";
  config?: AcpAutomationConfig | null;
}): Promise<AcpAutomationResponse | undefined> {
  const { store } = actions;
  if (!store) return undefined;
  const project_id = store.get("project_id");
  const path = store.get("path");
  if (!project_id || !path || !threadId) return undefined;
  return await webapp_client.conat_client.automationAcp({
    project_id,
    path,
    thread_id: threadId,
    action,
    config,
  });
}

export async function upsertThreadAutomation({
  actions,
  threadId,
  config,
}: {
  actions: ChatActions;
  threadId: string;
  config: AcpAutomationConfig;
}): Promise<AcpAutomationResponse | undefined> {
  return await automationRequest({
    actions,
    threadId,
    action: "upsert",
    config,
  });
}

export async function pauseThreadAutomation({
  actions,
  threadId,
}: {
  actions: ChatActions;
  threadId: string;
}): Promise<AcpAutomationResponse | undefined> {
  return await automationRequest({
    actions,
    threadId,
    action: "pause",
  });
}

export async function resumeThreadAutomation({
  actions,
  threadId,
}: {
  actions: ChatActions;
  threadId: string;
}): Promise<AcpAutomationResponse | undefined> {
  return await automationRequest({
    actions,
    threadId,
    action: "resume",
  });
}

export async function runThreadAutomationNow({
  actions,
  threadId,
}: {
  actions: ChatActions;
  threadId: string;
}): Promise<AcpAutomationResponse | undefined> {
  return await automationRequest({
    actions,
    threadId,
    action: "run_now",
  });
}

export async function acknowledgeThreadAutomation({
  actions,
  threadId,
}: {
  actions: ChatActions;
  threadId: string;
}): Promise<AcpAutomationResponse | undefined> {
  return await automationRequest({
    actions,
    threadId,
    action: "acknowledge",
  });
}

export async function deleteThreadAutomation({
  actions,
  threadId,
}: {
  actions: ChatActions;
  threadId: string;
}): Promise<AcpAutomationResponse | undefined> {
  return await automationRequest({
    actions,
    threadId,
    action: "delete",
  });
}

function normalizeCodexMention(model?: string): string | undefined {
  if (!model) return undefined;
  if (model === "codex-agent") {
    return undefined;
  }
  return model;
}

function resolveWorkingDir(chatPath?: string): string {
  if (!chatPath) return ".";
  const i = chatPath.lastIndexOf("/");
  if (i <= 0) return ".";
  return chatPath.slice(0, i);
}

function buildAcpConfig({
  path,
  config,
  model,
}: {
  path?: string;
  config?: CodexThreadConfig;
  model?: string;
}): CodexSessionConfig {
  const baseWorkingDir = resolveWorkingDir(path);
  const workingDirectory = config?.workingDirectory || baseWorkingDir;
  const opts: CodexSessionConfig = {
    workingDirectory,
  };
  const defaultModel =
    DEFAULT_CODEX_MODELS[0]?.name ?? DEFAULT_CODEX_MODEL_NAME;
  const selectedModel = config?.model ?? model ?? defaultModel;
  if (selectedModel) {
    opts.model = selectedModel;
  }
  const modelInfo = DEFAULT_CODEX_MODELS.find((m) => m.name === selectedModel);
  const selectedReasoning =
    config?.reasoning ?? modelInfo?.reasoning?.find((r) => r.default)?.id;
  if (selectedReasoning) {
    if (["low", "medium", "high", "extra_high"].includes(selectedReasoning)) {
      opts.reasoning = selectedReasoning as CodexSessionConfig["reasoning"];
    } else {
      console.error(
        "Invalid Codex reasoning level; expected one of low|medium|high|extra_high:",
        selectedReasoning,
      );
    }
  }
  const sessionMode = resolveCodexSessionMode(config);
  opts.sessionMode = sessionMode;
  opts.allowWrite = sessionMode !== "read-only";
  const env: Record<string, string> = {};
  if (config?.envHome) env.HOME = config.envHome;
  if (config?.envPath) env.PATH = config.envPath;
  if (Object.keys(env).length) {
    opts.env = env;
  }
  if (config?.codexPathOverride) {
    opts.codexPathOverride = config.codexPathOverride;
  }
  if (config?.sessionId) {
    opts.sessionId = config.sessionId;
  }
  return opts;
}

function buildChatMetadata({
  project_id,
  path,
  sender_id,
  api_url,
  browser_id,
  messageDate,
  thread_id,
  message_id,
  parent_message_id,
  sendMode,
  loop_config,
  loop_state,
}: {
  project_id?: string;
  path?: string;
  sender_id: string;
  api_url?: string;
  browser_id?: string;
  messageDate: Date;
  thread_id?: string;
  message_id?: string;
  parent_message_id?: string;
  sendMode?: "immediate";
  loop_config?: AcpLoopConfig;
  loop_state?: AcpLoopState;
}): AcpChatContext {
  if (!project_id) {
    throw new Error("Codex requires a project context to run");
  }
  if (!path) {
    throw new Error("Codex requires a chat file path");
  }
  if (!(messageDate instanceof Date) || Number.isNaN(messageDate.valueOf())) {
    throw new Error("Codex chat metadata missing timestamp");
  }
  return {
    project_id,
    path,
    sender_id,
    api_url,
    browser_id,
    message_date: messageDate.toISOString(),
    thread_id,
    message_id,
    parent_message_id,
    send_mode: sendMode,
    loop_config,
    loop_state,
  } as AcpChatContext;
}
