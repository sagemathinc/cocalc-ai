/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  AgentSessionIndex,
  createRemoteHeadlessChatClient,
  type AgentSessionRecord,
  type ChatSnapshot,
  type CodexThreadConfig,
  type HeadlessChatClient,
  type ProjectedChatMessage,
} from "@cocalc/chat-client";
import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import {
  DEFAULT_CODEX_MODEL_NAME,
  DEFAULT_CODEX_MODELS,
  DEFAULT_CODEX_MODEL_INFO,
  resolveCodexServiceTier,
  type CodexPaymentSourcePreference,
} from "@cocalc/util/ai/codex";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { navigate, type UltraliteRoute } from "./routes";
import type { UltraliteSession } from "./session";
import { fullProjectUrl } from "./urls";
import { Markdown } from "./markdown";
import {
  EmptyState,
  EssentialLink,
  InlineAlert,
  LoadingState,
  OverflowMenu,
  SurfaceHeader,
} from "./ui";
import {
  markUltraliteBackend,
  markUltralitePhase,
  recordUltraliteFailure,
  recordUltraliteOutcome,
  recordUltraliteSurfaceReady,
} from "./telemetry";

const ACTIVE_STATUS = new Set(["active", "running"]);
const INITIAL_MESSAGE_LIMIT = 30;
const MESSAGE_LIMIT_STEP = 30;
const MAX_RENDERED_MESSAGE_LENGTH = 200_000;
const PAYMENT_OPTIONS: {
  value: CodexPaymentSourcePreference;
  label: string;
}[] = [
  { value: "auto", label: "Automatic" },
  { value: "subscription", label: "ChatGPT subscription" },
  { value: "project-api-key", label: "Project API key" },
  { value: "account-api-key", label: "Account API key" },
  { value: "site-api-key", label: "CoCalc membership" },
  { value: "shared-home", label: "Shared Codex login" },
];

function paymentSourceLabel(source: CodexPaymentSourceInfo["source"]): string {
  return (
    {
      subscription: "ChatGPT subscription",
      "project-api-key": "Project API key",
      "account-api-key": "Account API key",
      "site-api-key": "CoCalc membership",
      "shared-home": "Shared Codex login",
      none: "Unavailable",
    } as const
  )[source];
}

function paymentOptionAvailable(
  value: CodexPaymentSourcePreference,
  info?: CodexPaymentSourceInfo,
): boolean {
  if (!info || value === "auto") return true;
  if (value === "subscription") return info.hasSubscription;
  if (value === "project-api-key") return info.hasProjectApiKey;
  if (value === "account-api-key") return info.hasAccountApiKey;
  if (value === "site-api-key") {
    return (
      info.hasSiteApiKey &&
      info.siteFundedCodex?.enabled === true &&
      info.siteAiUsageLimitPositive !== false
    );
  }
  return info.sharedHomeMode !== "disabled";
}

function boundedMessageContent(content: string): string {
  if (content.length <= MAX_RENDERED_MESSAGE_LENGTH) return content;
  return `${content.slice(0, MAX_RENDERED_MESSAGE_LENGTH)}\n\n[message truncated in Essential CoCalc]`;
}

export function SafeMessageContent({ content }: { content: string }) {
  return <Markdown source={boundedMessageContent(content)} />;
}

function sessionSort(records: AgentSessionRecord[]): AgentSessionRecord[] {
  return [...records].sort((a, b) => {
    const active =
      Number(ACTIVE_STATUS.has(b.status)) - Number(ACTIVE_STATUS.has(a.status));
    return (
      active ||
      new Date(b.updated_at).valueOf() - new Date(a.updated_at).valueOf()
    );
  });
}

export function AgentList({
  project,
  session,
}: {
  project: AccountProjectListWindowRow;
  session: UltraliteSession;
}) {
  const [records, setRecords] = useState<AgentSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let index: AgentSessionIndex | undefined;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    markUltraliteBackend("chat", "start");
    void session
      .openProjectHost(project.project_id, project.host_id!)
      .then(async ({ client }) => {
        if (cancelled) return;
        index = new AgentSessionIndex({
          client,
          project_id: project.project_id,
        });
        index.subscribe((next) => setRecords(sessionSort(next)));
        await index.open();
        if (!cancelled) {
          markUltraliteBackend("chat", "end");
          recordUltraliteSurfaceReady("chat");
        }
      })
      .catch((err) => {
        if (!cancelled) {
          markUltraliteBackend("chat", "end");
          recordUltraliteFailure("chat", err);
          setError(err instanceof Error ? err.message : `${err}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      index?.close();
    };
  }, [project.host_id, project.project_id, session]);

  const createCodexChat = async () => {
    if (creating) return;
    setCreating(true);
    setError(undefined);
    let client: HeadlessChatClient | undefined;
    try {
      const threadId = crypto.randomUUID();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const chatPath = `/home/user/${timestamp}-${threadId.slice(0, 6)}.chat`;
      const lease = await session.openProjectHost(
        project.project_id,
        project.host_id!,
      );
      client = createRemoteHeadlessChatClient({
        account_id: session.accountId,
        project_id: project.project_id,
        path: chatPath,
        projectHostClient: lease.client,
        selected_thread_id: threadId,
      });
      const model = DEFAULT_CODEX_MODEL_NAME;
      const reasoning = DEFAULT_CODEX_MODEL_INFO.reasoning?.find(
        ({ default: isDefault }) => isDefault,
      )?.id;
      await client.createCodexThread({
        acp_config: {
          allowWrite: true,
          model,
          paymentSource: "auto",
          reasoning,
          serviceTier: "standard",
          sessionMode: "workspace-write",
          workingDirectory: "/home/user",
        },
        name: "Codex chat",
        thread_id: threadId,
      });
      navigate({
        chatPath,
        kind: "chat",
        projectId: project.project_id,
        threadId,
      });
    } catch (err) {
      recordUltraliteFailure("chat", err);
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      await client?.close().catch(() => undefined);
      setCreating(false);
    }
  };

  return (
    <main className="ul-page" id="main-content">
      <SurfaceHeader
        actions={
          <div className="ul-toolbar">
            <button
              className="ul-button"
              disabled={creating}
              onClick={() => void createCodexChat()}
              type="button"
            >
              {creating ? "Creating..." : "New Codex chat"}
            </button>
            <OverflowMenu label="More Codex actions">
              <a
                className="ul-menu-item"
                data-ul-full-cocalc
                href={fullProjectUrl({ projectId: project.project_id })}
              >
                Open full CoCalc
              </a>
            </OverflowMenu>
          </div>
        }
        eyebrow="Existing sessions"
        title="Codex"
      />
      <p className="ul-muted">
        Start a focused Codex chat here, or continue an existing indexed session
        below.
      </p>
      {loading ? <LoadingState label="Loading Codex sessions" /> : null}
      {error ? <InlineAlert kind="error">{error}</InlineAlert> : null}
      {records.length ? (
        <div className="ul-session-list">
          {records.map((record) => (
            <EssentialLink
              aria-label={`Open ${record.title || "Codex session"}, ${record.status}`}
              className="ul-session-row"
              key={`${record.chat_path}:${record.thread_key}`}
              route={{
                kind: "chat",
                projectId: project.project_id,
                chatPath: record.chat_path,
                threadId: record.thread_key,
              }}
            >
              <div className="ul-row-title">
                {record.title || "Codex session"}
              </div>
              <div className="ul-row-detail">
                {[record.model, record.reasoning].filter(Boolean).join(" - ") ||
                  record.chat_path}
              </div>
              <span
                className={`ul-row-detail ${ACTIVE_STATUS.has(record.status) ? "ul-status-running" : ""}`}
              >
                {record.status} - updated{" "}
                {new Date(record.updated_at).toLocaleString()}
              </span>
            </EssentialLink>
          ))}
        </div>
      ) : !loading && !error ? (
        <EmptyState>No indexed Codex sessions were found.</EmptyState>
      ) : null}
    </main>
  );
}

function useChatSnapshot(
  client: HeadlessChatClient | undefined,
  projectId: string,
  path: string,
): ChatSnapshot {
  const fallback = useMemo<ChatSnapshot>(
    () => ({
      revision: 0,
      connection: "closed",
      ready: false,
      project_id: projectId,
      path,
      threads: [],
      messages: [],
    }),
    [path, projectId],
  );
  const subscribe = useCallback(
    (notify: () => void) =>
      client ? client.subscribe(() => notify()) : () => undefined,
    [client],
  );
  const getSnapshot = useCallback(
    () => client?.getSnapshot() ?? fallback,
    [client, fallback],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function Message({ message }: { message: ProjectedChatMessage }) {
  const human = message.role === "human";
  return (
    <article className={`ul-message ${human ? "ul-message-human" : ""}`}>
      <div className="ul-status">
        {human
          ? message.guidance
            ? "Guidance"
            : "You"
          : message.role === "agent"
            ? "Codex"
            : "System"}
        {message.state ? ` - ${message.state}` : ""}
      </div>
      {message.activity?.markdown ? (
        <details className="ul-activity" open={message.generating}>
          <summary>
            {message.generating ? "Codex activity" : "Activity"}
          </summary>
          <Markdown source={message.activity.markdown} />
        </details>
      ) : null}
      <div>
        <SafeMessageContent
          content={message.content || (message.generating ? "Working..." : "")}
        />
      </div>
    </article>
  );
}

export function Chat({
  project,
  route,
  session,
}: {
  project: AccountProjectListWindowRow;
  route: Extract<UltraliteRoute, { kind: "chat" }>;
  session: UltraliteSession;
}) {
  const [client, setClient] = useState<HeadlessChatClient>();
  const clientRef = useRef<HeadlessChatClient | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [paymentInfo, setPaymentInfo] = useState<CodexPaymentSourceInfo>();
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showNewest, setShowNewest] = useState(false);
  const [status, setStatus] = useState("Connecting...");
  const [error, setError] = useState<string>();
  const messagesRef = useRef<HTMLElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const followNewestRef = useRef(true);
  const firstHistoryRef = useRef(true);
  const snapshot = useChatSnapshot(client, project.project_id, route.chatPath);

  useEffect(() => {
    if (snapshot.ready) recordUltraliteSurfaceReady("chat");
  }, [snapshot.ready]);

  useEffect(() => {
    let cancelled = false;
    let opened: HeadlessChatClient | undefined;
    setError(undefined);
    setStatus("Connecting to the project host...");
    firstHistoryRef.current = true;
    followNewestRef.current = true;
    setShowNewest(false);
    markUltraliteBackend("chat", "start");
    void (async () => {
      markUltralitePhase("chat", "project-host-connect", "start");
      const lease = await session.openProjectHost(
        project.project_id,
        project.host_id!,
      );
      markUltralitePhase("chat", "project-host-connect", "end");
      if (cancelled) return;
      opened = createRemoteHeadlessChatClient({
        account_id: session.accountId,
        project_id: project.project_id,
        path: route.chatPath,
        projectHostClient: lease.client,
        selected_thread_id: route.threadId,
        initial_message_limit: INITIAL_MESSAGE_LIMIT,
        onOpenPhase: (phase) => {
          const starting = phase.endsWith("_start");
          const suffix = starting ? "_start" : "_done";
          const name = phase.slice(0, -suffix.length).split("_").join("-");
          markUltralitePhase(
            "chat",
            `chat-${name}`,
            starting ? "start" : "end",
          );
        },
      });
      clientRef.current = opened;
      setClient(opened);
      await opened.open();
      if (!cancelled) {
        markUltraliteBackend("chat", "end");
        setStatus("Live Codex session");
      }
    })().catch((err) => {
      if (!cancelled) {
        markUltraliteBackend("chat", "end");
        recordUltraliteFailure("chat", err);
        setError(err instanceof Error ? err.message : `${err}`);
        setStatus("Disconnected");
      }
    });
    return () => {
      cancelled = true;
      clientRef.current = undefined;
      setClient(undefined);
      void opened?.close();
    };
  }, [
    project.host_id,
    project.project_id,
    route.chatPath,
    route.threadId,
    session,
  ]);

  const selectedThread = snapshot.threads.find(
    ({ thread_id }) => thread_id === route.threadId,
  );
  const canSend =
    snapshot.ready &&
    !submitting &&
    !!draft.trim() &&
    (selectedThread?.agent_kind === "acp" ||
      selectedThread?.acp_config != null);
  const visibleMessages = snapshot.messages;
  const generating =
    selectedThread?.state === "running" ||
    snapshot.messages.some((message) => message.generating);
  const configuredModel =
    selectedThread?.acp_config?.model ??
    selectedThread?.agent_model ??
    DEFAULT_CODEX_MODEL_NAME;
  const configuredPayment = selectedThread?.acp_config?.paymentSource ?? "auto";
  const sitePolicy =
    paymentInfo?.source === "site-api-key"
      ? paymentInfo?.siteFundedCodex?.policy
      : undefined;
  const displayedModel = sitePolicy?.model ?? configuredModel;
  const modelInfo =
    DEFAULT_CODEX_MODELS.find(({ name }) => name === displayedModel) ??
    DEFAULT_CODEX_MODEL_INFO;
  const configuredReasoning =
    sitePolicy?.reasoning ??
    selectedThread?.acp_config?.reasoning ??
    modelInfo?.reasoning?.find(({ default: isDefault }) => isDefault)?.id ??
    modelInfo?.reasoning?.[0]?.id;

  useEffect(() => {
    if (!snapshot.ready || !session.hubApi?.system?.getCodexPaymentSource) {
      setPaymentInfo(undefined);
      return;
    }
    let cancelled = false;
    setPaymentInfo(undefined);
    setPaymentLoading(true);
    void session.hubApi.system
      .getCodexPaymentSource({
        project_id: project.project_id,
        preference: configuredPayment,
      })
      .then((info) => {
        if (!cancelled) setPaymentInfo(info);
      })
      .catch((err) => {
        if (!cancelled) {
          recordUltraliteFailure("chat", err);
          setPaymentInfo(undefined);
        }
      })
      .finally(() => {
        if (!cancelled) setPaymentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [configuredPayment, project.project_id, session, snapshot.ready]);

  const newestSignature = visibleMessages.length
    ? `${visibleMessages.at(-1)?.message_id}:${visibleMessages.at(-1)?.revision_date}:${visibleMessages.at(-1)?.content.length}:${visibleMessages.at(-1)?.activity?.markdown?.length ?? 0}`
    : "empty";

  useEffect(() => {
    if (!snapshot.ready || !visibleMessages.length) return;
    if (firstHistoryRef.current || followNewestRef.current) {
      firstHistoryRef.current = false;
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({
          behavior: followNewestRef.current ? "smooth" : "auto",
          block: "end",
        });
      });
    } else {
      setShowNewest(true);
    }
  }, [newestSignature, snapshot.ready, visibleMessages.length]);

  const handleMessageScroll = () => {
    const host = messagesRef.current;
    if (!host) return;
    const nearEnd = host.scrollHeight - host.scrollTop - host.clientHeight < 96;
    followNewestRef.current = nearEnd;
    if (nearEnd) setShowNewest(false);
  };

  const goToNewest = () => {
    followNewestRef.current = true;
    setShowNewest(false);
    messagesEndRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  };

  const loadOlder = async () => {
    const active = clientRef.current;
    const host = messagesRef.current;
    if (!active?.loadOlderMessages || !host || loadingOlder) return;
    const previousHeight = host.scrollHeight;
    const previousTop = host.scrollTop;
    setLoadingOlder(true);
    setError(undefined);
    try {
      await active.loadOlderMessages(
        (snapshot.message_window?.limit ?? INITIAL_MESSAGE_LIMIT) +
          MESSAGE_LIMIT_STEP,
      );
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!messagesRef.current) return;
          messagesRef.current.scrollTop =
            previousTop + messagesRef.current.scrollHeight - previousHeight;
        }),
      );
    } catch (err) {
      recordUltraliteFailure("chat", err);
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setLoadingOlder(false);
    }
  };

  const submitText = async (text: string, clearDraft: boolean) => {
    const active = clientRef.current;
    const normalized = text.trim();
    if (!active || !snapshot.ready || submitting || !normalized) return;
    setSubmitting(true);
    setError(undefined);
    try {
      if (generating) {
        await active.sendGuidanceToCodexThread({
          thread_id: route.threadId,
          text: normalized,
        });
      } else {
        await active.sendToExistingCodexThread({
          thread_id: route.threadId,
          text: normalized,
        });
      }
      if (clearDraft) setDraft("");
      recordUltraliteOutcome(
        "chat",
        generating ? "codex_guidance" : "codex_prompt",
      );
    } catch (err) {
      recordUltraliteFailure("chat", err);
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setSubmitting(false);
    }
  };

  const send = async () => {
    if (!canSend) return;
    await submitText(draft, true);
  };

  const refresh = async () => {
    const active = clientRef.current;
    if (!active || refreshing) return;
    setRefreshing(true);
    setError(undefined);
    setStatus("Refreshing...");
    try {
      await active.reconnect("constrained-client-user-request");
      setStatus("Live Codex session");
    } catch (err) {
      recordUltraliteFailure("chat", err);
      setError(err instanceof Error ? err.message : `${err}`);
      setStatus("Disconnected");
    } finally {
      setRefreshing(false);
    }
  };

  const updateConfig = async (patch: Partial<CodexThreadConfig>) => {
    const active = clientRef.current;
    if (!active || !selectedThread || savingConfig) return;
    const current: CodexThreadConfig = {
      ...(selectedThread.acp_config ?? {}),
      model: configuredModel,
    };
    const next = { ...current, ...patch };
    next.serviceTier = resolveCodexServiceTier(next);
    setSavingConfig(true);
    setError(undefined);
    try {
      await active.updateCodexThreadConfig({
        thread_id: route.threadId,
        acp_config: next,
      });
    } catch (err) {
      recordUltraliteFailure("chat", err);
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setSavingConfig(false);
    }
  };

  const interrupt = async () => {
    const active = clientRef.current;
    if (!active || interrupting) return;
    setInterrupting(true);
    setError(undefined);
    try {
      await active.interrupt(route.threadId);
      setStatus("Interrupt confirmed");
    } catch (err) {
      recordUltraliteFailure("chat", err);
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setInterrupting(false);
    }
  };

  return (
    <main className="ul-page" id="main-content">
      <SurfaceHeader
        actions={
          <OverflowMenu label="Codex chat actions">
            <EssentialLink
              className="ul-menu-item"
              route={{ kind: "agents", projectId: project.project_id }}
            >
              Codex sessions
            </EssentialLink>
            <button
              className="ul-menu-item"
              disabled={!client || refreshing}
              onClick={() => void refresh()}
              type="button"
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            <a
              className="ul-menu-item"
              data-ul-full-cocalc
              href={fullProjectUrl({
                projectId: project.project_id,
                path: route.chatPath,
              })}
            >
              Full CoCalc
            </a>
          </OverflowMenu>
        }
        eyebrow={status}
        title={selectedThread?.name || "Codex chat"}
      />
      {snapshot.connection === "disconnected" ||
      snapshot.connection === "error" ? (
        <InlineAlert kind="warning">
          The live Codex connection was interrupted. Use Refresh to reconnect
          and load current activity.
        </InlineAlert>
      ) : null}
      {snapshot.error ? (
        <InlineAlert kind="error">{snapshot.error}</InlineAlert>
      ) : null}
      {error ? <InlineAlert kind="error">{error}</InlineAlert> : null}
      <section aria-label="Codex settings" className="ul-codex-config">
        <label>
          <span>Model</span>
          <select
            aria-label="Model"
            className="ul-select"
            disabled={!snapshot.ready || savingConfig || !!sitePolicy}
            onChange={(event) => {
              const model = event.target.value;
              const info = DEFAULT_CODEX_MODELS.find(
                ({ name }) => name === model,
              );
              const reasoning =
                info?.reasoning?.find(({ default: isDefault }) => isDefault)
                  ?.id ?? info?.reasoning?.[0]?.id;
              void updateConfig({ model, reasoning });
            }}
            value={displayedModel}
          >
            {!DEFAULT_CODEX_MODELS.some(
              ({ name }) => name === displayedModel,
            ) ? (
              <option value={displayedModel}>{displayedModel}</option>
            ) : null}
            {DEFAULT_CODEX_MODELS.map(({ name }) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Reasoning</span>
          <select
            aria-label="Reasoning"
            className="ul-select"
            disabled={!snapshot.ready || savingConfig || !!sitePolicy}
            onChange={(event) =>
              void updateConfig({
                reasoning: event.target.value as CodexThreadConfig["reasoning"],
              })
            }
            value={configuredReasoning}
          >
            {modelInfo?.reasoning?.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Paid by</span>
          <select
            aria-label="Paid by"
            className="ul-select"
            disabled={!snapshot.ready || savingConfig}
            onChange={(event) =>
              void updateConfig({
                paymentSource: event.target
                  .value as CodexPaymentSourcePreference,
              })
            }
            value={configuredPayment}
          >
            {PAYMENT_OPTIONS.map(({ value, label }) => (
              <option
                disabled={
                  value !== configuredPayment &&
                  !paymentOptionAvailable(value, paymentInfo)
                }
                key={value}
                value={value}
              >
                {value === "auto" &&
                paymentInfo &&
                paymentInfo.source !== "none"
                  ? `${label} (${paymentSourceLabel(paymentInfo.source)})`
                  : label}
              </option>
            ))}
          </select>
        </label>
        <span className="ul-codex-config-note">
          {savingConfig
            ? "Saving..."
            : paymentLoading
              ? "Checking payment..."
              : sitePolicy
                ? "Membership model policy"
                : (paymentInfo?.unavailableReason ?? "Next turn settings")}
        </span>
      </section>
      <div className="ul-chat-layout">
        <section
          aria-label="Chat messages"
          className="ul-messages"
          onScroll={handleMessageScroll}
          ref={messagesRef}
        >
          {snapshot.message_window?.has_older ? (
            <div className="ul-history-notice">
              <span>
                {snapshot.message_window.omitted.toLocaleString()} older
                messages are not loaded.
              </span>
              <button
                className="ul-icon-button"
                disabled={loadingOlder}
                onClick={() => void loadOlder()}
                type="button"
              >
                {loadingOlder ? "Loading..." : "Load 30 older"}
              </button>
            </div>
          ) : null}
          {visibleMessages.map((message) => (
            <Message key={message.message_id} message={message} />
          ))}
          {!visibleMessages.length ? (
            <EmptyState>
              {snapshot.ready
                ? "No messages yet. Send a message to begin."
                : "Waiting for chat history..."}
            </EmptyState>
          ) : null}
          <div aria-hidden="true" ref={messagesEndRef} />
        </section>
        {showNewest ? (
          <button
            className="ul-newest-button"
            onClick={goToNewest}
            type="button"
          >
            New messages
          </button>
        ) : null}
        <form
          className="ul-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label className="ul-visually-hidden" htmlFor="ul-codex-prompt">
            Message Codex
          </label>
          <textarea
            className="ul-textarea"
            id="ul-codex-prompt"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={
              generating
                ? "Send guidance to the running turn..."
                : "What should Codex do next?"
            }
            value={draft}
          />
          <div className="ul-toolbar">
            <button className="ul-button" disabled={!canSend} type="submit">
              {submitting
                ? "Sending..."
                : generating
                  ? "Send guidance"
                  : "Send"}
            </button>
            {generating ? (
              <button
                className="ul-button ul-button-danger"
                disabled={interrupting}
                onClick={() => void interrupt()}
                type="button"
              >
                {interrupting ? "Stopping..." : "Stop"}
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </main>
  );
}

export default function ChatSurface({
  project,
  route,
  session,
}: {
  project: AccountProjectListWindowRow;
  route: Extract<UltraliteRoute, { kind: "agents" | "chat" }>;
  session: UltraliteSession;
}) {
  return route.kind === "agents" ? (
    <AgentList project={project} session={session} />
  ) : (
    <Chat project={project} route={route} session={session} />
  );
}
