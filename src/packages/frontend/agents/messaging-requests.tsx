import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Space } from "antd";
import type { PersonalConnectionRequest } from "@cocalc/conat/agents/personal";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { personalAgentApi, sameEndpoint, useNamedAgents } from "./api";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { useBoundAgentAccount } from "./use-bound-account";
import { useSourceAgentName } from "./source-agent-name";

/** A first-party typed request inbox. Reading/denying/approving never dispatches a message. */
interface Props {
  projectId?: string;
  threadId?: string;
  path?: string;
  requestId?: string;
}
export function AgentMessagingRequests(props: Props) {
  const accountId = useTypedRedux("account", "account_id");
  return accountId ? (
    <AccountMessagingRequests
      key={`${accountId}:${props.projectId}:${props.path}:${props.threadId}`}
      accountId={accountId}
      {...props}
    />
  ) : null;
}

function AccountMessagingRequests({
  accountId,
  projectId,
  threadId,
  path,
  requestId,
}: Props & { accountId: string }) {
  const { directory } = useNamedAgents();
  const boundAccount = useBoundAgentAccount();
  const [requests, setRequests] = useState<PersonalConnectionRequest[]>([]);
  const [selected, setSelected] = useState<PersonalConnectionRequest>();
  const [busy, setBusy] = useState(false);
  const sourceNaming = useSourceAgentName(selected?.source, undefined, busy);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  useEffect(() => {
    let disposed = false;
    let loading = false;
    async function load() {
      if (disposed || loading || lock.current) return;
      loading = true;
      try {
        const api = personalAgentApi();
        const { enabled, requests } = await api.listPersonalConnectionRequests(
          {},
        );
        if (disposed) return;
        if (!enabled) {
          setRequests([]);
          setSelected(undefined);
          setLoadError("");
          return;
        }
        const identity =
          projectId && threadId && path
            ? await api.resolveIdentity({
                project_id: projectId,
                thread_id: threadId,
                path,
              })
            : undefined;
        if (!disposed) {
          setLoadError("");
          setRequests(
            requests.filter(
              (request) =>
                request.account_id === accountId &&
                (!requestId || request.request_id === requestId) &&
                request.state === "pending" &&
                Date.parse(request.expires_at) > Date.now() &&
                (!projectId ||
                  (identity &&
                    sameEndpoint(request.source, {
                      project_id: projectId,
                      agent_id: identity.agent_id,
                    }))),
            ),
          );
          setSelected(
            (current) =>
              current &&
              requests.find(
                (request) =>
                  request.request_id === current.request_id &&
                  request.account_id === accountId &&
                  request.state === "pending" &&
                  Date.parse(request.expires_at) > Date.now(),
              ),
          );
        }
      } catch (err) {
        if (!disposed) setLoadError(`${err}`);
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(
      () => {
        if (!lock.current) void load();
      },
      projectId ? 3000 : 15000,
    );
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [accountId, projectId, threadId, path, requestId, revision]);
  const label = (endpoint) => {
    const agent = directory?.agents.find((agent) =>
      sameEndpoint(agent.endpoint, endpoint),
    );
    return agent
      ? `@${agent.name} (${agent.thread_title ?? "Agent thread"} / ${agent.project_title ?? "Project"})`
      : `${endpoint.agent_id} / ${endpoint.project_id}`;
  };
  async function resolve(decision: "approve" | "deny") {
    if (!selected || selected.account_id !== accountId || lock.current) return;
    if (decision === "approve" && !sourceNaming.canApprove) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const completed = await runFreshAuthAction(async () => {
        boundAccount.assertCurrent();
        if (!alive.current)
          throw new Error(
            "The account or thread changed. Review the request in the current session.",
          );
        if (decision === "approve") await sourceNaming.ensureNamed();
        boundAccount.assertCurrent();
        if (!alive.current)
          throw new Error(
            "The request context changed. Review it in the current session.",
          );
        await personalAgentApi().resolvePersonalConnectionRequest({
          request_id: selected.request_id,
          decision,
        });
      });
      if (completed) {
        setSelected(undefined);
        setRevision((n) => n + 1);
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (!requests.length && !error && !loadError) return null;
  return (
    <section aria-label="Agent messaging approvals">
      <div role="status">
        {requests.length} agent messaging approval request
        {requests.length === 1 ? "" : "s"}
      </div>
      {requests.map((request) => (
        <div key={request.request_id}>
          <Button
            size="small"
            onClick={() => {
              setError("");
              setSelected(request);
            }}
          >
            Review messaging request: {label(request.source)} to{" "}
            {label(request.target)}
          </Button>
        </div>
      ))}
      {(error || loadError) && !selected && (
        <div role="alert">
          <Alert
            type="warning"
            title="Messaging approvals unavailable"
            description={error || loadError}
          />
        </div>
      )}
      <Modal
        open={!!selected}
        title="Agent requests messaging approval"
        footer={
          <Space wrap>
            <Button
              disabled={busy}
              onClick={() => {
                setError("");
                setSelected(undefined);
              }}
            >
              Later
            </Button>
            <Button danger disabled={busy} onClick={() => void resolve("deny")}>
              Deny request
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={busy || !sourceNaming.canApprove}
              onClick={() => void resolve("approve")}
            >
              Approve requested connection
            </Button>
          </Space>
        }
        onCancel={() => {
          if (!busy) {
            setError("");
            setSelected(undefined);
          }
        }}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        {selected && (
          <>
            <p>
              {label(selected.source)} requests permission to message{" "}
              {label(selected.target)} under your account.
            </p>
            <p>Reason: {selected.reason}</p>
            {sourceNaming.field}
            {error && <Alert type="error" title={error} role="alert" />}
            {loadError && (
              <Alert type="warning" title={loadError} role="alert" />
            )}
            <p>
              Direction:{" "}
              {selected.both_directions ? "Both directions" : "One way"}.
              Duration:{" "}
              {selected.ttl_seconds === null
                ? "Never expires"
                : `${(selected.ttl_seconds ?? 86400) / 3600} hours`}
              .
            </p>
            {selected.allow_guidance && (
              <Alert
                type="warning"
                title="This request also permits guidance during active turns"
              />
            )}
            <p>
              Approval creates a grant only. The agent must deliberately try
              sending again. No send is replayed, and your draft remains
              private.
            </p>
            <details>
              <summary>Request details</summary>
              <p>Run: {selected.run_id}</p>
              <p>Request: {selected.request_id}</p>
              <p>
                Approval deadline:{" "}
                {new Date(selected.expires_at).toLocaleString()}
              </p>
            </details>
          </>
        )}
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </section>
  );
}
