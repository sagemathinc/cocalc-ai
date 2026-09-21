import { useEffect, useId, useState } from "react";
import { Alert, Button, Modal } from "antd";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { agentThreadUrl } from "@cocalc/frontend/chat/agent-thread-url";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import { personalAgentApi } from "./api";

export function FreshConversationModal({
  name,
  agent,
  onConfirm,
  onClose,
}: {
  name: string;
  agent?: NamedAgent;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] =
    useState<AgentIdentity["conversation_history"]>();
  const [historyError, setHistoryError] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const historyId = useId();
  const projectId = agent?.endpoint.project_id;
  const agentId = agent?.endpoint.agent_id;
  useEffect(() => {
    if (!projectId || !agentId) return;
    let disposed = false;
    setHistory(undefined);
    setHistoryError("");
    void personalAgentApi()
      .getIdentity({ project_id: projectId, agent_id: agentId })
      .then((identity) => {
        if (!disposed) setHistory(identity.conversation_history ?? []);
      })
      .catch((err) => {
        if (!disposed)
          setHistoryError(`Unable to load past conversations: ${err}`);
      });
    return () => {
      disposed = true;
    };
  }, [projectId, agentId]);
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={`Start a fresh conversation with @${name}?`}
      modalRender={(modal) => <KeyboardBoundary>{modal}</KeyboardBoundary>}
      okText="Start fresh conversation"
      confirmLoading={busy}
      cancelButtonProps={{ disabled: busy }}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      onOk={() => void confirm()}
      onCancel={() => !busy && onClose()}
    >
      <p>
        Keep this agent's name, networks, appearance, settings, and files. The
        previous conversation is preserved, but its messages will not be
        included in the new context.
      </p>
      <p>
        Finish or cancel running and queued work first. Disable scheduled work
        before continuing.
      </p>
      {agent && (
        <>
          <Button
            aria-expanded={showHistory}
            aria-controls={historyId}
            disabled={busy}
            onClick={() => setShowHistory((show) => !show)}
          >
            Past Threads
          </Button>
          <section
            id={historyId}
            hidden={!showHistory}
            aria-label="Past conversations"
            style={{ marginTop: 16 }}
          >
            <p>
              Return to this modal to open past threads. Links open the
              conversation in the project chat file; they do not change this
              agent's current context.
            </p>
            <p>
              To make an agent from a past conversation, use its thread menu's
              <strong> Fork chat...</strong> action, then click{" "}
              <strong>Name agent</strong> and set the name. This keeps the
              original conversation intact.
            </p>
            {historyError ? (
              <Alert role="alert" type="error" title={historyError} />
            ) : history === undefined ? (
              <p role="status">Loading past conversations...</p>
            ) : history.length === 0 ? (
              <p>No past conversations yet.</p>
            ) : (
              <ul
                style={{ maxHeight: 240, overflowY: "auto", paddingLeft: 24 }}
              >
                {[...history].reverse().map(({ thread_id, ended_at }) => (
                  <li key={thread_id}>
                    <a
                      href={
                        busy
                          ? undefined
                          : agentThreadUrl(
                              agent.endpoint.project_id,
                              agent.path,
                              thread_id,
                            )
                      }
                      aria-disabled={busy || undefined}
                    >
                      {name} · ended {new Date(ended_at).toLocaleString()}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      {error && (
        <Alert
          role="alert"
          type="error"
          showIcon
          title={error}
          description="If preparation was interrupted, retry here to finish the same switch. No conversation is deleted."
        />
      )}
    </Modal>
  );
}
