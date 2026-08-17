/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  AgentSessionIndex,
  createRemoteHeadlessChatClient,
  type AgentSessionRecord,
  type ChatSnapshot,
  type HeadlessChatClient,
  type ProjectedChatMessage,
} from "@cocalc/chat-client";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
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
import { EmptyState, InlineAlert, LoadingState, SurfaceHeader } from "./ui";
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

function AgentList({
  project,
  session,
}: {
  project: AccountProjectListWindowRow;
  session: UltraliteSession;
}) {
  const [records, setRecords] = useState<AgentSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
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

  return (
    <main className="ul-page" id="main-content">
      <SurfaceHeader
        actions={
          <a
            className="ul-link-button ul-link-button-subtle"
            data-ul-full-cocalc
            href={fullProjectUrl({ projectId: project.project_id })}
          >
            Create in full CoCalc
          </a>
        }
        eyebrow="Existing sessions"
        title="Codex"
      />
      <p className="ul-muted">
        Essential CoCalc continues existing indexed sessions. Creating a new
        Codex thread still uses the full workspace.
      </p>
      {loading ? <LoadingState label="Loading Codex sessions" /> : null}
      {error ? <InlineAlert kind="error">{error}</InlineAlert> : null}
      {records.length ? (
        <div className="ul-session-list">
          {records.map((record) => (
            <button
              aria-label={`Open ${record.title || "Codex session"}, ${record.status}`}
              className="ul-session-row"
              key={`${record.chat_path}:${record.thread_key}`}
              onClick={() =>
                navigate({
                  kind: "chat",
                  projectId: project.project_id,
                  chatPath: record.chat_path,
                  threadId: record.thread_key,
                })
              }
              type="button"
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
            </button>
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
        {human ? "You" : message.role === "agent" ? "Codex" : "System"}
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
  const [reconnecting, setReconnecting] = useState(false);
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
  const generating = snapshot.messages.some((message) => message.generating);
  const canContinue =
    snapshot.ready &&
    !submitting &&
    !generating &&
    (selectedThread?.agent_kind === "acp" ||
      selectedThread?.acp_config != null);

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
      await active.sendToExistingCodexThread({
        thread_id: route.threadId,
        text: normalized,
      });
      if (clearDraft) setDraft("");
      setStatus("Prompt accepted by Codex");
      recordUltraliteOutcome("chat", "codex_prompt");
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

  const reconnect = async () => {
    const active = clientRef.current;
    if (!active || reconnecting) return;
    setReconnecting(true);
    setError(undefined);
    setStatus("Catching up...");
    try {
      await active.reconnect("constrained-client-user-request");
      setStatus("Live Codex session");
    } catch (err) {
      recordUltraliteFailure("chat", err);
      setError(err instanceof Error ? err.message : `${err}`);
      setStatus("Disconnected");
    } finally {
      setReconnecting(false);
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
          <>
            <button
              className="ul-icon-button"
              onClick={() =>
                navigate({ kind: "agents", projectId: project.project_id })
              }
              type="button"
            >
              Codex sessions
            </button>
            <button
              className="ul-icon-button"
              disabled={!client || reconnecting}
              onClick={() => void reconnect()}
              type="button"
            >
              {reconnecting ? "Catching up..." : "Catch up"}
            </button>
            <a
              className="ul-link-button ul-link-button-subtle"
              data-ul-full-cocalc
              href={fullProjectUrl({
                projectId: project.project_id,
                path: route.chatPath,
              })}
            >
              Full CoCalc
            </a>
          </>
        }
        eyebrow={status}
        title={selectedThread?.name || "Codex chat"}
      />
      {snapshot.connection === "disconnected" ||
      snapshot.connection === "error" ? (
        <InlineAlert kind="warning">
          The live Codex connection was interrupted. Use Catch up to reconnect
          and load current activity.
        </InlineAlert>
      ) : null}
      {snapshot.error ? (
        <InlineAlert kind="error">{snapshot.error}</InlineAlert>
      ) : null}
      {error ? <InlineAlert kind="error">{error}</InlineAlert> : null}
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
            <EmptyState>Waiting for chat history...</EmptyState>
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
          <label htmlFor="ul-codex-prompt">
            <strong>Message Codex</strong>
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
            placeholder="What should Codex do next?"
            value={draft}
          />
          <div className="ul-toolbar">
            <button className="ul-button" disabled={!canSend} type="submit">
              {submitting ? "Sending..." : "Send"}
            </button>
            {!generating ? (
              <button
                className="ul-button ul-button-secondary"
                disabled={!canContinue}
                onClick={() => void submitText("continue", false)}
                type="button"
              >
                {submitting ? "Sending..." : "Continue Codex"}
              </button>
            ) : null}
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
