import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { AcpChatContext } from "@cocalc/conat/ai/acp/types";
import {
  DEFAULT_CODEX_MODELS,
  resolveCodexSessionMode,
  type CodexSessionConfig,
} from "@cocalc/util/ai/codex";
import { uuid } from "@cocalc/util/misc";
import type { ChatMessage } from "./types";
import type { CodexThreadConfig } from "@cocalc/chat";
import { dateValue, field } from "./access";
import { type ChatActions } from "./actions";

type QueueKey = string;
type QueueItem = {
  messageDateMs: number;
  run: () => Promise<void>;
  canceled: boolean;
};
type QueueState = { running: boolean; items: QueueItem[] };
const turnQueues: Map<QueueKey, QueueState> = new Map();
let lastGeneratedAcpMessageMs = 0;

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

function getQueue(key: QueueKey): QueueState {
  let q = turnQueues.get(key);
  if (q == null) {
    q = { running: false, items: [] };
    turnQueues.set(key, q);
  }
  return q;
}

function makeQueueKey({ project_id, path, threadKey }): QueueKey {
  return `${project_id}::${path}::${threadKey}`;
}

type ThreadQueueRef = {
  queueKey: QueueKey;
  threadToken: string;
  project_id: string;
  path: string;
};

function resolveThreadQueueRef({
  actions,
  threadRootDate,
}: {
  actions: ChatActions;
  threadRootDate: Date;
}): ThreadQueueRef | undefined {
  const store = actions.store;
  if (!store) return undefined;
  const project_id = store.get("project_id");
  const path = store.get("path");
  if (!project_id || !path) return undefined;
  const threadKey = actions.computeThreadKey(threadRootDate.valueOf());
  const rootMessage =
    actions.getMessageByDate?.(threadRootDate) ??
    actions.getAllMessages?.().get(`${threadRootDate.valueOf()}`);
  const threadToken = field<string>(rootMessage, "thread_id") ?? threadKey;
  if (!threadToken) return undefined;
  return {
    queueKey: makeQueueKey({ project_id, path, threadKey: threadToken }),
    threadToken,
    project_id,
    path,
  };
}

// Clear stale in-memory queue/running state for a thread.
// This is important after backend restarts or interrupted turns so a new
// "continue" can start immediately instead of remaining queued forever.
export function resetAcpThreadState({
  actions,
  threadRootDate,
}: {
  actions: ChatActions;
  threadRootDate: Date;
}): void {
  const store = actions.store;
  if (!store) return;
  const queueRef = resolveThreadQueueRef({ actions, threadRootDate });
  if (queueRef) {
    const q = turnQueues.get(queueRef.queueKey);
    if (q) {
      for (const item of q.items) {
        item.canceled = true;
      }
      q.items = [];
      q.running = false;
      turnQueues.delete(queueRef.queueKey);
    }
  }

  const threadIso = threadRootDate.toISOString();
  const threadMessages = actions.getMessagesInThread(threadIso) ?? [];
  let nextState = store.get("acpState");
  for (const msg of threadMessages) {
    const d = dateValue(msg);
    if (!d) continue;
    nextState = nextState.delete(`${d.valueOf()}`);
    const threadId = field<string>(msg, "thread_id");
    if (threadId) {
      nextState = nextState.delete(`thread:${threadId}`);
    }
  }
  nextState = nextState.delete(`${threadRootDate.valueOf()}`);
  store.setState({ acpState: nextState });
}

async function runQueue(key: QueueKey): Promise<void> {
  const q = turnQueues.get(key);
  if (!q) return;
  let next = q.items.shift();
  while (next && next.canceled) {
    next = q.items.shift();
  }
  if (!next) {
    q.running = false;
    if (q.items.length === 0) {
      turnQueues.delete(key);
    }
    return;
  }
  q.running = true;
  try {
    await next.run();
  } catch (err) {
    console.error("ACP turn queue job failed", err);
  } finally {
    void runQueue(key);
  }
}

type ProcessAcpRequest = {
  message: ChatMessage;
  model: string;
  input: string;
  actions: ChatActions;
  reply_to?: Date;
  sendMode?: "immediate";
};

export async function processAcpLLM({
  message,
  model,
  input,
  actions,
  reply_to,
  sendMode,
}: ProcessAcpRequest): Promise<void> {
  const { syncdb, store, chatStreams } = actions;
  if (syncdb == null || store == null) return;

  let workingInput = input?.trim();
  if (!workingInput) {
    return;
  }

  let baseDate: number;
  if (reply_to) {
    baseDate = reply_to.valueOf();
  } else {
    baseDate =
      message.date instanceof Date
        ? message.date.valueOf()
        : new Date(message.date ?? Date.now()).valueOf();
  }
  const threadKey: string | undefined = actions.computeThreadKey(baseDate);
  if (!threadKey) {
    return;
  }

  const sender_id = model || "openai-codex-agent";

  // Determine the thread root date from the message itself.
  // - For replies, `message.reply_to` is the thread root (ISO string).
  // - For a root message, the thread root is `message.date`.
  const messageDate = dateValue(message);
  if (!messageDate) {
    throw Error("invalid message");
  }
  const threadRootDate = message.reply_to
    ? new Date(message.reply_to)
    : messageDate;
  if (Number.isNaN(threadRootDate?.valueOf())) {
    throw new Error("ACP turn missing thread root date");
  }

  const config = actions.getCodexConfig?.(threadRootDate);
  const normalizedModel =
    typeof model === "string" ? normalizeCodexMention(model) : undefined;
  const threadRootMessage =
    actions.getMessageByDate?.(threadRootDate) ??
    actions.getAllMessages?.().get(`${threadRootDate.valueOf()}`);
  const thread_id =
    (message as any)?.thread_id ?? (threadRootMessage as any)?.thread_id;
  const message_id = (message as any)?.message_id;
  const reply_to_message_id =
    (threadRootMessage as any)?.message_id;

  const id = uuid();
  chatStreams.add(id);
  // NOTE: the stream is ONLY used to submit the message for acp;
  // the actual resonse is via a pub/sub channel.  Thus this 3 minutes
  // is fine, even if the response is very long.
  setTimeout(() => chatStreams.delete(id), 3 * 60 * 1000);

  const setState = (state) => {
    const rootKey = `${threadRootDate.valueOf()}`;
    const messageKey = `${messageDate.valueOf()}`;
    const threadStateKey = thread_id ? `thread:${thread_id}` : undefined;
    let next = store.get("acpState");
    if (state) {
      next = next.set(messageKey, state).set(rootKey, state);
      if (threadStateKey) {
        next = next.set(threadStateKey, state);
      }
    } else {
      next = next.delete(messageKey).delete(rootKey);
      if (threadStateKey) {
        next = next.delete(threadStateKey);
      }
    }
    store.setState({
      acpState: next,
    });
  };

  const project_id = store.get("project_id");
  const path = store.get("path");

  const threadToken = thread_id ?? threadKey;
  const sessionKey = config?.sessionId ?? threadToken;
  const queueKey = makeQueueKey({ project_id, path, threadKey: threadToken });
  const job = async (): Promise<void> => {
    try {
      setState("sending");
      // Generate a stable assistant-reply key for this turn, but do NOT write any
      // corresponding chat row here. The backend is the sole writer of the assistant
      // reply row (avoids frontend/backend sync races on the same row).
      // Chat cache and thread lookup currently key by millisecond timestamp.
      // Never allow ACP assistant rows to reuse an existing timestamp.
      const newMessageDate = nextAcpMessageDate({
        actions,
        minMs: Math.max(messageDate.valueOf(), threadRootDate.valueOf()) + 1,
      });
      const chatMetadata = buildChatMetadata({
        project_id,
        path,
        sender_id,
        messageDate: newMessageDate,
        reply_to: threadRootDate,
        thread_id,
        message_id,
        reply_to_message_id,
        sendMode,
      });
      console.log("Starting ACP turn for", { message, chatMetadata });
      const stream = await webapp_client.conat_client.streamAcp({
        project_id,
        prompt: workingInput,
        session_id: sessionKey,
        config: buildAcpConfig({
          path,
          config,
          model: normalizedModel,
        }),
        chat: chatMetadata,
      });
      setState("sent");
      console.log("Sent ACP turn request for", message);
      for await (const response of stream) {
        setState("running");
        // TODO: this is excess logging for development purposes
        console.log("ACP message response", response);
        // when something goes wrong, the stream may send this sort of message:
        // {seq: 0, error: 'Error: ACP agent is already processing a request', type: 'error'}
        if (response?.type == "error") {
          throw Error(response.error);
        }
      }
      console.log("ACP message responses done");
    } catch (err) {
      chatStreams.delete(id);
      console.error("ACP turn failed", err);
      // Backend owns the assistant reply row, but if we fail before the backend
      // can even start the turn (e.g., immediate stream error), we still want
      // the user to see *something* in the chat UI.
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
          reply_to: threadRootDate,
        });
        syncdb.commit();
      } catch (writeErr) {
        console.error("Failed to write ACP error reply", writeErr);
      }
    } finally {
      setState("");
    }
  };

  const q = getQueue(queueKey);
  q.items.push({
    messageDateMs: messageDate.valueOf(),
    run: job,
    canceled: false,
  });
  setState("queue");
  if (!q.running) {
    void runQueue(queueKey);
  }
}

export function cancelQueuedAcpTurn({
  actions,
  message,
}: {
  actions: ChatActions;
  message: ChatMessage;
}): boolean {
  const { store } = actions;
  if (!store) return false;
  const messageDate = dateValue(message);
  if (!messageDate) return false;
  const legacyThreadKey = actions.computeThreadKey(messageDate.valueOf());
  const threadToken = field<string>(message, "thread_id") ?? legacyThreadKey;
  if (!threadToken) return false;
  const project_id = store.get("project_id");
  const path = store.get("path");
  if (!project_id || !path) return false;
  const queueKey = makeQueueKey({ project_id, path, threadKey: threadToken });
  const q = turnQueues.get(queueKey);
  if (!q) return false;
  const targetIndex = q.items.findIndex(
    (item) => item.messageDateMs === messageDate.valueOf(),
  );
  if (targetIndex < 0) return false;
  const [item] = q.items.splice(targetIndex, 1);
  item.canceled = true;
  if (!q.running && q.items.length === 0) {
    turnQueues.delete(queueKey);
  }
  store.setState({
    acpState: (() => {
      let next = store
        .get("acpState")
        .set(`${messageDate.valueOf()}`, "not-sent");
      if (legacyThreadKey) {
        next = next.set(`${legacyThreadKey}`, "not-sent");
      }
      const threadId = field<string>(message, "thread_id");
      if (threadId) {
        next = next.set(`thread:${threadId}`, "not-sent");
      }
      return next;
    })(),
  });
  return true;
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
  const defaultModel = DEFAULT_CODEX_MODELS[0]?.name ?? "gpt-5.3-codex";
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
  messageDate,
  reply_to,
  thread_id,
  message_id,
  reply_to_message_id,
  sendMode,
}: {
  project_id?: string;
  path?: string;
  sender_id: string;
  messageDate: Date;
  reply_to?: Date;
  thread_id?: string;
  message_id?: string;
  reply_to_message_id?: string;
  sendMode?: "immediate";
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
    message_date: messageDate.toISOString(),
    reply_to: reply_to?.toISOString(),
    thread_id,
    message_id,
    reply_to_message_id,
    send_mode: sendMode,
  };
}
