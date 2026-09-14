import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Select,
  Space,
  Typography,
} from "antd";
import type { AgentApi, AgentGrant } from "@cocalc/conat/hub/api/agent";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import CopyButton from "@cocalc/frontend/components/copy-button";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { uuid } from "@cocalc/util/misc";
import { useChatComposerDraft } from "./use-chat-composer-draft";
import { agentThreadUrl, parseAgentThreadUrl } from "./agent-thread-url";

type Api = Pick<
  AgentApi,
  | "resolveIdentity"
  | "registerIdentity"
  | "grantRpcLink"
  | "listRpcLinks"
  | "revokeRpcLink"
>;
interface Props {
  api: Api;
  projectId: string;
  path: string;
  threadId: string;
  accountId: string;
}

export function AgentCommunication(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Agent communication" style={{ marginTop: 16 }}>
      <Button size="small" aria-expanded={open} onClick={() => setOpen(!open)}>
        Agent communication (experimental)
      </Button>
      {open && (
        <CommunicationPanel
          key={`${props.accountId}:${props.projectId}:${props.path}:${props.threadId}`}
          {...props}
        />
      )}
    </section>
  );
}

export function CommunicationPanel({
  api,
  projectId,
  path,
  threadId,
  accountId,
}: Props) {
  const [identity, setIdentity] = useState<AgentIdentity>();
  const [grants, setGrants] = useState<
    (Omit<AgentGrant, "expires_at"> & { expires_at: string | null })[]
  >([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState<AgentIdentity>();
  const [previewUrl, setPreviewUrl] = useState("");
  const approvalAttempt = useRef<
    { payload: string; grantId: string } | undefined
  >(undefined);
  const [ttl, setTtl] = useState(86400);
  const [guidance, setGuidance] = useState(false);
  const alive = useRef(true);
  const lock = useRef(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const draftOptions = {
    account_id: accountId,
    project_id: projectId,
    path,
    composerDraftKey: 0,
  };
  const urlDraft = useChatComposerDraft({
    ...draftOptions,
    suffix: `agent-link:${accountId}:${threadId}:url`,
  });
  const reasonDraft = useChatComposerDraft({
    ...draftOptions,
    suffix: `agent-link:${accountId}:${threadId}:reason`,
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    void (async () => {
      try {
        const value = await api.resolveIdentity({
          project_id: projectId,
          path,
          thread_id: threadId,
        });
        const rpcLinks = value
          ? await api.listRpcLinks({
              source: { project_id: projectId, agent_id: value.agent_id },
            })
          : undefined;
        if (value && rpcLinks === undefined)
          throw new Error("RPC links are unavailable on this client");
        const page = {
          items: (rpcLinks ?? []).map((link) => ({
            grant_id: link.link_id,
            source_agent_id: link.source.agent_id,
            target_agent_id: link.target.agent_id,
            approved_by: link.approved_by,
            reason: link.reason,
            expires_at: link.expires_at,
            revoked_at: link.revoked_at,
            allow_guidance: link.allow_guidance,
          })),
          next_cursor: undefined,
        };
        if (disposed) return;
        setIdentity(value);
        setGrants(page?.items ?? []);
        setLoaded(true);
        setError("");
      } catch (err) {
        if (!disposed) {
          setLoaded(false);
          setError(`${err}`);
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [api, projectId, path, threadId, accountId, revision]);

  // Poll only while this panel is open, never during an approval/mutation.
  useEffect(() => {
    if (busy) return;
    const timer = setInterval(() => setRevision((value) => value + 1), 15000);
    return () => clearInterval(timer);
  }, [busy]);

  async function act(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (err) {
      if (alive.current) setError(`${err}`);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function mutate(action: () => Promise<void>, success: string) {
    await act(async () => {
      const completed = await runFreshAuthAction(async () => {
        if (!alive.current) return;
        await action();
      });
      if (completed && alive.current) {
        setNotice(success);
        setRevision((value) => value + 1);
      }
    });
  }

  const threadUrl = agentThreadUrl(projectId, path, threadId);
  return (
    <div style={{ marginTop: 12, minWidth: 0 }}>
      <Typography.Paragraph type="secondary">
        A one-way link permits messages, not project access. Idle agents wake
        automatically; ordinary messages queue behind active turns. RPC links
        can cross bays on this CoCalc site. Acceptance is not completion; failed
        or uncertain sends are never retried automatically.
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">
        Showing outgoing RPC links only. Legacy records are not replayed or
        converted. Create a separate connection from the other thread to allow
        replies.
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Typography.Text>This agent's address</Typography.Text>
        <CopyButton
          value={threadUrl}
          noText
          ariaLabel="Copy this agent's address"
        />
        <Button
          size="small"
          loading={loading}
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh connections
        </Button>
      </Space>
      {error && (
        <Alert
          type="error"
          showIcon
          title="Agent communication unavailable"
          description={error}
          style={{ marginBottom: 12 }}
        />
      )}
      {notice && (
        <div role="status">
          <Alert
            type="success"
            showIcon
            title={notice}
            style={{ marginBottom: 12 }}
          />
        </div>
      )}
      {loaded && !identity && (
        <Button
          disabled={busy || loading}
          loading={busy}
          onClick={() =>
            void mutate(async () => {
              await api.registerIdentity({
                project_id: projectId,
                path,
                thread_id: threadId,
              });
            }, "Thread registered. Its next agent turn can use the identity.")
          }
        >
          Register this thread
        </Button>
      )}
      {loaded && identity && (
        <>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <Typography.Text style={{ overflowWrap: "anywhere" }}>
              Agent: {identity.agent_id}
            </Typography.Text>
            <CopyButton
              value={identity.agent_id}
              noText
              ariaLabel="Copy agent ID"
            />
          </div>
          {identity.disabled_at && (
            <Alert type="warning" title="This agent identity is disabled" />
          )}
          <>
            <Typography.Title level={5}>Connections</Typography.Title>
            {!grants.length && (
              <Typography.Paragraph type="secondary">
                No connections yet.
              </Typography.Paragraph>
            )}
            {grants.map((grant) => {
              const outgoing = grant.source_agent_id === identity.agent_id;
              const state = grant.revoked_at
                ? "Revoked"
                : grant.expires_at &&
                    new Date(grant.expires_at).valueOf() <= Date.now()
                  ? "Expired"
                  : "Active";
              return (
                <div
                  key={grant.grant_id}
                  role="group"
                  aria-label={`${outgoing ? "Outgoing" : "Incoming"} connection ${grant.grant_id}`}
                  style={{
                    padding: "8px 0",
                    color: UI_COLORS.text,
                    overflowWrap: "anywhere",
                  }}
                >
                  <div>
                    <strong>{outgoing ? "Outgoing" : "Incoming"}</strong>:{" "}
                    {outgoing ? grant.target_agent_id : grant.source_agent_id}
                  </div>
                  <Space wrap>
                    <Typography.Text>
                      {state} |{" "}
                      {grant.allow_guidance ? "Guidance allowed" : "Queue only"}
                    </Typography.Text>
                    {state === "Active" && (
                      <Button
                        size="small"
                        danger
                        disabled={busy}
                        aria-label={`Revoke connection ${grant.grant_id}`}
                        onClick={() =>
                          void mutate(async () => {
                            await api.revokeRpcLink({
                              source: {
                                project_id: projectId,
                                agent_id: identity.agent_id,
                              },
                              link_id: grant.grant_id,
                            });
                          }, "Connection revoked. Already-accepted queued or running work is not canceled.")
                        }
                      >
                        Revoke
                      </Button>
                    )}
                  </Space>
                  <details>
                    <summary>Connection details</summary>
                    <div>
                      Expires:{" "}
                      {grant.expires_at
                        ? new Date(grant.expires_at).toLocaleString()
                        : "Never expires"}
                    </div>
                    <div>Reason: {grant.reason}</div>
                    <div>Approved by: {grant.approved_by}</div>
                    <div>Grant: {grant.grant_id}</div>
                  </details>
                </div>
              );
            })}
          </>
          {!identity.disabled_at && (
            <div style={{ marginTop: 16 }}>
              <Typography.Title level={5}>
                Connect to another agent
              </Typography.Title>
              <label htmlFor={`agent-target-${threadId}`}>
                Other agent's address
              </label>
              <Input
                id={`agent-target-${threadId}`}
                value={urlDraft.input}
                disabled={busy}
                placeholder="Paste the other agent's address"
                aria-describedby={`agent-target-help-${threadId}`}
                onChange={(event) => {
                  urlDraft.setInput(event.target.value);
                  setTarget(undefined);
                }}
              />
              <Typography.Paragraph
                id={`agent-target-help-${threadId}`}
                type="secondary"
              >
                In the other thread's Codex settings, expand Agent communication
                and copy This agent's address. Paste it here, preview, then
                approve the one-way connection. Replies need a separate reverse
                connection.
              </Typography.Paragraph>
              <Button
                style={{ marginTop: 8 }}
                size="small"
                disabled={busy || !urlDraft.input.trim()}
                onClick={() =>
                  void act(async () => {
                    const resolved = await api.resolveIdentity(
                      parseAgentThreadUrl(urlDraft.input.trim()),
                    );
                    if (!resolved)
                      throw new Error(
                        "Register the target thread first using its Codex settings.",
                      );
                    if (resolved.agent_id === identity.agent_id)
                      throw new Error(
                        "Choose a different thread; self-links are not supported.",
                      );
                    if (resolved.disabled_at)
                      throw new Error("The target identity is disabled.");
                    if (alive.current) {
                      setTarget(resolved);
                      setPreviewUrl(urlDraft.input);
                    }
                  })
                }
              >
                Preview connection
              </Button>
              {target && previewUrl === urlDraft.input && (
                <div style={{ marginTop: 12 }}>
                  <Typography.Paragraph style={{ overflowWrap: "anywhere" }}>
                    {identity.name} sends to <strong>{target.name}</strong> (
                    {target.project_id}). Recipient execution account:{" "}
                    {target.created_by}. No reverse permission is created.
                  </Typography.Paragraph>
                  {target.created_by !== accountId ? (
                    <Alert
                      type="info"
                      title="The target registrant must approve this link"
                      description="Ask that person to open these settings and approve the connection. They must collaborate on both projects."
                    />
                  ) : (
                    <>
                      <label htmlFor={`agent-reason-${threadId}`}>
                        Approval reason
                      </label>
                      <Input.TextArea
                        id={`agent-reason-${threadId}`}
                        maxLength={1024}
                        autoSize={{ minRows: 2, maxRows: 5 }}
                        value={reasonDraft.input}
                        disabled={busy}
                        onChange={(event) =>
                          reasonDraft.setInput(event.target.value)
                        }
                      />
                      <Space wrap style={{ marginTop: 8 }}>
                        <Select
                          aria-label="Connection lifetime"
                          value={ttl}
                          disabled={busy}
                          onChange={setTtl}
                          options={[
                            { value: 3600, label: "1 hour" },
                            { value: 86400, label: "24 hours" },
                            { value: 604800, label: "7 days" },
                            { value: 2592000, label: "30 days" },
                          ]}
                        />
                        <Checkbox
                          checked={guidance}
                          disabled={busy}
                          onChange={(event) =>
                            setGuidance(event.target.checked)
                          }
                        >
                          Allow guidance during active turns
                        </Checkbox>
                      </Space>
                      <div style={{ marginTop: 12 }}>
                        <Button
                          type="primary"
                          disabled={busy || !reasonDraft.input.trim()}
                          loading={busy}
                          onClick={() =>
                            void mutate(async () => {
                              const payload = {
                                source_agent_id: identity.agent_id,
                                target_agent_id: target.agent_id,
                                ttl_seconds: ttl,
                                reason: reasonDraft.input.trim(),
                                allow_guidance: guidance,
                              };
                              const serialized = JSON.stringify(payload);
                              if (
                                approvalAttempt.current?.payload !== serialized
                              )
                                approvalAttempt.current = {
                                  payload: serialized,
                                  grantId: uuid(),
                                };
                              const grant = await api.grantRpcLink({
                                source: {
                                  project_id: projectId,
                                  agent_id: identity.agent_id,
                                },
                                target: {
                                  project_id: target.project_id,
                                  agent_id: target.agent_id,
                                },
                                link_id: approvalAttempt.current.grantId,
                                ttl_seconds: ttl,
                                reason: reasonDraft.input.trim(),
                                allow_guidance: guidance,
                              });
                              if (
                                grant.revoked_at ||
                                (grant.expires_at != null &&
                                  new Date(grant.expires_at).valueOf() <=
                                    Date.now())
                              )
                                throw new Error(
                                  "This approval is no longer active. Refresh connections before creating a new approval.",
                                );
                              if (alive.current) {
                                setTarget(undefined);
                                setGuidance(false);
                                approvalAttempt.current = undefined;
                              }
                            }, "One-way connection approved.")
                          }
                        >
                          Approve one-way connection
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}
