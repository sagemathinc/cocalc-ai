import { useEffect, useRef, useState } from "react";
import { Alert, Modal, Space } from "antd";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { uuid } from "@cocalc/util/misc";
import { personalAgentApi } from "./api";
import { useBoundAgentAccount } from "./use-bound-account";
import { useSourceAgentName } from "./source-agent-name";
import type { AgentNameContext } from "./name-context";
import { cachedAgentNameContext } from "./name-context";

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

export function SessionApproval({
  value,
  onClose,
}: {
  value: SessionApprovalTarget;
  onClose: (approved: boolean) => void;
}) {
  const boundAccount = useBoundAgentAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  const requestId = useRef(uuid());
  const sourceNaming = useSourceAgentName(
    value.source,
    value.sourceName,
    busy,
    value.sourceContext,
  );
  const sourceContext = value.sourceContext
    ? cachedAgentNameContext(value.sourceContext)
    : undefined;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function create() {
    if (lock.current || !sourceNaming.canApprove) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      boundAccount.assertCurrent();
      await sourceNaming.ensureNamed();
      boundAccount.assertCurrent();
      if (!alive.current) throw new Error("The session context changed.");
      await personalAgentApi().createAgentSession({
        request_id: requestId.current,
        title: `${sourceNaming.known?.name ?? value.sourceLabel.replace(/^@/, "")} and ${value.targetName?.name ?? value.targetLabel.replace(/^@/, "")}`,
        delivery_mode: "queued",
        members: [
          { kind: "registered", endpoint: value.source },
          { kind: "registered", endpoint: value.target },
        ],
      });
      onClose(true);
    } catch (err) {
      setError(`${err}`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  if (!boundAccount.current) return null;
  return (
    <Modal
      open
      title="Create Agent Session"
      okText="Create session"
      confirmLoading={busy}
      okButtonProps={{ disabled: busy || !sourceNaming.canApprove }}
      onOk={() => void create()}
      onCancel={() => {
        if (!busy) onClose(false);
      }}
      modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        <p>
          Create a two-way session between <strong>{value.sourceLabel}</strong>{" "}
          and <strong>{value.targetLabel}</strong>. Either agent may message the
          other.
        </p>
        <div>
          From: {sourceContext?.thread_title ?? value.sourceLabel} /{" "}
          {sourceContext?.project_title ?? "Project name unavailable"}
        </div>
        <div>
          To: {value.targetName?.thread_title ?? value.targetLabel} /{" "}
          {value.targetName?.project_title ?? "Project name unavailable"}
        </div>
        {sourceNaming.field}
        <p>
          Messages use queued delivery by default: they wake an idle agent or
          wait behind its active turn. Creating the session grants permission;
          it does not send this draft or start either agent.
        </p>
        <p>
          If these agents are in different projects, this creates a two-way
          prompt and data bridge between those projects and requires fresh
          authentication.
        </p>
        {error && (
          <div role="alert">
            <Alert
              type="error"
              title="Unable to create session"
              description={error}
            />
          </div>
        )}
      </Space>
    </Modal>
  );
}
