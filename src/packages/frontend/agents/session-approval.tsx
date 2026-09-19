import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Radio, Space, Spin, Tag } from "antd";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import type {
  AgentSession,
  AgentSessionDirectory,
  AgentSessionMember,
  NamedAgent,
} from "@cocalc/conat/agents/personal";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { uuid } from "@cocalc/util/misc";
import { personalAgentApi, sameEndpoint } from "./api";
import { useBoundAgentAccount } from "./use-bound-account";
import { useSourceAgentName } from "./source-agent-name";
import type { AgentNameContext } from "./name-context";
import { cachedAgentNameContext } from "./name-context";

const NEW_SESSION = "new";

export interface SessionApprovalTarget {
  source: AgentEndpoint;
  target: AgentEndpoint;
  sourceLabel: string;
  targetLabel: string;
  sourceName?: NamedAgent;
  sourceContext?: AgentNameContext;
  targetName?: NamedAgent;
  namingAccountId?: string;
}

function registeredMember(
  session: AgentSession,
  endpoint: AgentEndpoint,
): AgentSessionMember | undefined {
  return session.members.find(
    (member) =>
      member.kind === "registered" && sameEndpoint(member.endpoint, endpoint),
  );
}

function memberLabel(member: AgentSessionMember): string {
  if (member.kind === "external") return member.label || "External agent";
  return member.name
    ? `@${member.name}`
    : member.thread_title?.trim() || "Agent";
}

function sessionLabel(session: AgentSession): string {
  return session.title?.trim() || "Untitled Agent Session";
}

async function loadAllSessions(): Promise<AgentSessionDirectory> {
  let cursor: string | undefined;
  let directory: AgentSessionDirectory | undefined;
  const sessions: AgentSession[] = [];
  do {
    const page = await personalAgentApi().listAgentSessions({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    directory = page;
    sessions.push(...page.sessions);
    cursor = page.next_cursor;
  } while (cursor && sessions.length < 1000);
  if (!directory) throw new Error("Agent Sessions are unavailable");
  return { ...directory, sessions };
}

export function SessionApproval({
  value,
  onClose,
}: {
  value: SessionApprovalTarget;
  onClose: (approved: boolean) => void;
}) {
  const boundAccount = useBoundAgentAccount();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [directory, setDirectory] = useState<AgentSessionDirectory>();
  const [selection, setSelection] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  const loadRevision = useRef(0);
  const requestIds = useRef(new Map<string, string>());
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const sourceNaming = useSourceAgentName(
    value.source,
    value.sourceName,
    busy,
    value.sourceContext,
  );
  const sourceContext = value.sourceContext
    ? cachedAgentNameContext(value.sourceContext)
    : undefined;

  const targetSessions =
    directory?.sessions.filter(
      (session) =>
        session.state === "active" && !!registeredMember(session, value.target),
    ) ?? [];
  const sharedSession = targetSessions.find((session) =>
    registeredMember(session, value.source),
  );
  const joinableSessions = targetSessions.filter(
    (session) =>
      !registeredMember(session, value.source) &&
      session.members.length < (directory?.usage.member_limit ?? 0),
  );
  const selectedSession = joinableSessions.find(
    ({ agent_session_id }) => agent_session_id === selection,
  );
  const selectedProjects = new Set(
    selectedSession?.members.flatMap((member) =>
      member.kind === "registered" ? [member.endpoint.project_id] : [],
    ) ?? [],
  );
  const crossesProject = selectedSession
    ? selectedProjects.size > 0 &&
      !selectedProjects.has(value.source.project_id)
    : value.source.project_id !== value.target.project_id;
  const creating = selection === NEW_SESSION;
  const atSessionLimit =
    !!directory &&
    directory.usage.active_sessions >= directory.usage.session_limit;
  const canSubmit =
    !busy &&
    !loading &&
    !loadError &&
    sourceNaming.canApprove &&
    (!!sharedSession ||
      !!selectedSession ||
      (creating && !!newTitle.trim() && !atSessionLimit));

  function requestId(key: string): string {
    let request = requestIds.current.get(key);
    if (!request) {
      request = uuid();
      requestIds.current.set(key, request);
    }
    return request;
  }

  async function load() {
    const revision = ++loadRevision.current;
    setLoading(true);
    setLoadError("");
    try {
      const next = await loadAllSessions();
      if (!alive.current || revision !== loadRevision.current) return;
      setDirectory(next);
      const activeForTarget = next.sessions.filter(
        (session) =>
          session.state === "active" &&
          !!registeredMember(session, value.target),
      );
      const shared = activeForTarget.find((session) =>
        registeredMember(session, value.source),
      );
      const firstJoinable = activeForTarget.find(
        (session) =>
          !registeredMember(session, value.source) &&
          session.members.length < next.usage.member_limit,
      );
      setSelection(
        shared?.agent_session_id ??
          firstJoinable?.agent_session_id ??
          NEW_SESSION,
      );
    } catch (err) {
      if (alive.current && revision === loadRevision.current)
        setLoadError(`${err}`);
    } finally {
      if (alive.current && revision === loadRevision.current) setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      loadRevision.current += 1;
    };
  }, []);

  async function connect() {
    if (lock.current || !canSubmit) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      boundAccount.assertCurrent();
      await sourceNaming.ensureNamed();
      boundAccount.assertCurrent();
      if (!alive.current) throw new Error("The session context changed.");
      if (sharedSession) {
        onClose(true);
        return;
      }
      const completed = await runFreshAuthAction(async () => {
        boundAccount.assertCurrent();
        if (selectedSession) {
          const key = `join:${selectedSession.agent_session_id}:${value.source.agent_id}:${selectedSession.generation}`;
          await personalAgentApi().updateAgentSession({
            request_id: requestId(key),
            agent_session_id: selectedSession.agent_session_id,
            action: "add-member",
            member: { kind: "registered", endpoint: value.source },
          });
        } else {
          const title = newTitle.trim();
          const key = `create:${title}:${value.source.agent_id}:${value.target.agent_id}`;
          await personalAgentApi().createAgentSession({
            request_id: requestId(key),
            title,
            delivery_mode: "queued",
            members: [
              { kind: "registered", endpoint: value.source },
              { kind: "registered", endpoint: value.target },
            ],
          });
        }
      });
      if (!completed) return;
      requestIds.current.clear();
      if (alive.current) onClose(true);
    } catch (err) {
      setError(`${err}`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  if (!boundAccount.current) return null;
  const sourceLabel = sourceNaming.known
    ? `@${sourceNaming.known.name}`
    : value.sourceLabel;
  return (
    <>
      <Modal
        open
        width={640}
        title="Connect agents"
        okText={
          sharedSession
            ? "Use shared session"
            : selectedSession
              ? "Join session"
              : "Create session"
        }
        confirmLoading={busy}
        okButtonProps={{ disabled: !canSubmit }}
        onOk={() => void connect()}
        onCancel={() => {
          if (!busy) onClose(false);
        }}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <p style={{ margin: 0 }}>
            Connect <strong>{sourceLabel}</strong> with{" "}
            <strong>{value.targetLabel}</strong> through a topic-oriented Agent
            Session.
          </p>
          <div style={{ color: UI_COLORS.secondary }}>
            {sourceContext?.thread_title ?? value.sourceLabel} /{" "}
            {sourceContext?.project_title ?? "Project name unavailable"}
            <span aria-hidden="true"> → </span>
            {value.targetName?.thread_title ?? value.targetLabel} /{" "}
            {value.targetName?.project_title ?? "Project name unavailable"}
          </div>
          {sourceNaming.field}
          {loading && (
            <div role="status" style={{ textAlign: "center", padding: 20 }}>
              <Spin /> Loading {value.targetLabel}&apos;s sessions...
            </div>
          )}
          {loadError && (
            <Alert
              type="error"
              title="Unable to load Agent Sessions"
              description={
                <Space orientation="vertical">
                  <span>{loadError}</span>
                  <Button size="small" onClick={() => void load()}>
                    Try again
                  </Button>
                </Space>
              }
            />
          )}
          {!loading && !loadError && sharedSession && (
            <Alert
              type="success"
              title="These agents already share a session"
              description={sessionLabel(sharedSession)}
            />
          )}
          {!loading && !loadError && !sharedSession && (
            <Radio.Group
              aria-label="Choose an Agent Session"
              value={selection}
              onChange={(event) => setSelection(event.target.value)}
              style={{ width: "100%" }}
            >
              <Space orientation="vertical" style={{ width: "100%" }}>
                {joinableSessions.length > 0 && (
                  <strong>Join an existing session</strong>
                )}
                {joinableSessions.map((session) => (
                  <div
                    key={session.agent_session_id}
                    style={{
                      border: `1px solid ${selection === session.agent_session_id ? UI_COLORS.info : UI_COLORS.border}`,
                      borderRadius: 8,
                      padding: "10px 12px",
                      background:
                        selection === session.agent_session_id
                          ? UI_COLORS.infoBg
                          : UI_COLORS.surface,
                    }}
                  >
                    <Radio value={session.agent_session_id}>
                      <strong>{sessionLabel(session)}</strong>
                    </Radio>
                    <div
                      style={{
                        margin: "7px 0 0 24px",
                        color: UI_COLORS.secondary,
                      }}
                    >
                      <Space wrap size={[4, 4]}>
                        {session.members.map((member) => (
                          <Tag key={member.member_id}>
                            {memberLabel(member)}
                          </Tag>
                        ))}
                        <Tag>{session.delivery_mode} delivery</Tag>
                      </Space>
                    </div>
                  </div>
                ))}
                {targetSessions.length > joinableSessions.length && (
                  <div style={{ color: UI_COLORS.secondary }}>
                    {targetSessions.length - joinableSessions.length} other
                    active session
                    {targetSessions.length - joinableSessions.length === 1
                      ? " is"
                      : "s are"}{" "}
                    full.
                  </div>
                )}
                <div
                  style={{
                    border: `1px solid ${creating ? UI_COLORS.info : UI_COLORS.border}`,
                    borderRadius: 8,
                    padding: "10px 12px",
                    background: creating ? UI_COLORS.infoBg : UI_COLORS.surface,
                  }}
                >
                  <Radio value={NEW_SESSION} disabled={atSessionLimit}>
                    <strong>Create a new topic session</strong>
                  </Radio>
                  {creating && (
                    <div style={{ margin: "9px 0 0 24px" }}>
                      <label htmlFor="new-agent-session-topic">
                        Session topic
                      </label>
                      <Input
                        id="new-agent-session-topic"
                        autoFocus
                        value={newTitle}
                        maxLength={120}
                        onChange={(event) => setNewTitle(event.target.value)}
                        placeholder="Illustration work"
                        style={{ marginTop: 5 }}
                      />
                    </div>
                  )}
                </div>
              </Space>
            </Radio.Group>
          )}
          {selectedSession && (
            <Alert
              type="info"
              title={`Add ${sourceLabel} to ${sessionLabel(selectedSession)}`}
              description={`${sourceLabel} will be able to message every current member, and every member will be able to message ${sourceLabel}.`}
            />
          )}
          {crossesProject && !sharedSession && (
            <Alert
              type="warning"
              title="Cross-project prompt and data bridge"
              description="This expands the session into another project. Fresh authentication is required before the change is applied."
            />
          )}
          {!sharedSession && (
            <p style={{ margin: 0, color: UI_COLORS.secondary }}>
              Connecting grants permission only. It does not send this draft or
              start any agent. Messages use the selected session&apos;s delivery
              mode; new sessions start with queued delivery.
            </p>
          )}
          {error && (
            <div role="alert">
              <Alert
                type="error"
                title="Unable to connect agents"
                description={error}
              />
            </div>
          )}
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
