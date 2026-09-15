import { useId, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Space } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { normalizeAgentName } from "@cocalc/conat/agents/personal";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { personalAgentApi, refreshNamedAgents, useNamedAgents } from "./api";
import { useBoundAgentAccount } from "./use-bound-account";
import { AgentNameInput, agentNameProblem } from "./agent-name-input";
import { cachedAgentNameContext } from "./name-context";
import { useAgentMessagingUI } from "./use-ui-preference";

export function NameAgent(props: Parameters<typeof EnabledNameAgent>[0]) {
  return useAgentMessagingUI() ? <EnabledNameAgent {...props} /> : null;
}

function EnabledNameAgent({
  agent,
  projectId,
  path,
  threadId,
  threadTitle,
  projectTitle,
  initiallyOpen = false,
}: {
  agent?: NamedAgent;
  projectId: string;
  path: string;
  threadId: string;
  threadTitle?: string;
  projectTitle?: string;
  initiallyOpen?: boolean;
}) {
  const id = useId();
  const boundAccount = useBoundAgentAccount();
  const { directory } = useNamedAgents();
  const [open, setOpen] = useState(initiallyOpen);
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const problem = agentNameProblem(
    name,
    directory?.agents ?? [],
    agent?.endpoint ?? {
      project_id: projectId,
      path,
      thread_id: threadId,
    },
  );
  async function save() {
    if (lock.current || problem) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const normalized = normalizeAgentName(name);
      boundAccount.assertCurrent();
      const api = personalAgentApi();
      let endpoint = agent?.endpoint;
      if (!endpoint) {
        const locator = { project_id: projectId, path, thread_id: threadId };
        let identity = await api.resolveIdentity(locator);
        boundAccount.assertCurrent();
        if (!identity) {
          const completed = await runFreshAuthAction(async () => {
            boundAccount.assertCurrent();
            identity = await api.registerIdentity(locator);
            boundAccount.assertCurrent();
          });
          if (!completed) return;
        }
        if (!identity) throw new Error("Unable to register this agent thread");
        endpoint = { project_id: projectId, agent_id: identity.agent_id };
      }
      boundAccount.assertCurrent();
      await api.nameAgent({
        endpoint,
        name: normalized,
        description,
        ...cachedAgentNameContext({
          project_id: projectId,
          path,
          thread_id: threadId,
          thread_title: threadTitle,
        }),
        ...(threadTitle != null ? { thread_title: threadTitle } : {}),
        ...(projectTitle != null ? { project_title: projectTitle } : {}),
      });
      boundAccount.assertCurrent();
      refreshNamedAgents();
      setOpen(false);
    } catch (err) {
      setError(`${err}`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (!boundAccount.current) return null;
  return (
    <>
      <Button
        size="small"
        aria-label={agent ? `Rename @${agent.name}` : "Name agent"}
        onClick={() => {
          setName(agent?.name ?? "");
          setDescription(agent?.description ?? "");
          setError("");
          setOpen(true);
        }}
      >
        {agent ? `@${agent.name} - Rename` : "Name agent"}
      </Button>
      <Modal
        open={open}
        title="Name in your agents"
        okText="Save agent name"
        confirmLoading={busy}
        okButtonProps={{ disabled: !!problem || busy }}
        onOk={() => void save()}
        onCancel={() => {
          if (!busy) setOpen(false);
        }}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <p>
            This name is in your account across projects. Naming does not start
            work, grant communication, or make shared chat history private.
          </p>
          <AgentNameInput
            id={`${id}-name`}
            value={name}
            busy={busy}
            problem={name.trim() ? problem : undefined}
            onChange={setName}
            onEnter={() => void save()}
          />
          <label htmlFor={`${id}-description`}>Description (optional)</label>
          <Input.TextArea
            id={`${id}-description`}
            value={description}
            maxLength={500}
            disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
          {error && (
            <div role="alert">
              <Alert type="error" title={error} />
            </div>
          )}
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
