import { useEffect, useId, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Space } from "antd";
import type { ButtonProps } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { normalizeAgentName } from "@cocalc/conat/agents/personal";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { personalAgentApi, refreshNamedAgents, useNamedAgents } from "./api";
import { useBoundAgentAccount } from "./use-bound-account";
import {
  AgentNameInput,
  agentNameProblem,
  isAgentNameRename,
} from "./agent-name-input";
import { cachedAgentNameContext } from "./name-context";
import {
  isNamedAgentLimitError,
  namedAgentLimitReached,
  NamedAgentLimitAlert,
  NamedAgentUsage,
} from "./agent-limit";

export function NameAgent({
  agent,
  projectId,
  path,
  threadId,
  threadTitle,
  projectTitle,
  initiallyOpen = false,
  triggerLabel,
  triggerButtonProps,
  modalTitle,
}: {
  agent?: NamedAgent;
  projectId: string;
  path: string;
  threadId: string;
  threadTitle?: string;
  projectTitle?: string;
  initiallyOpen?: boolean;
  triggerLabel?: string;
  triggerButtonProps?: ButtonProps;
  modalTitle?: string;
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
  const problem = agentNameProblem(
    name,
    directory?.agents ?? [],
    agent?.endpoint ?? {
      project_id: projectId,
      path,
      thread_id: threadId,
    },
  );
  const atLimit = !agent && namedAgentLimitReached(directory);
  // Someone else's agent (e.g. shared with you): naming it adds it to your
  // agents, so say that, and suggest the name it already has.
  const [sharedName, setSharedName] = useState<string>();
  useEffect(() => {
    if (agent) return;
    let canceled = false;
    setSharedName(undefined);
    void personalAgentApi()
      .resolveIdentity({ project_id: projectId, path, thread_id: threadId })
      .then((identity) => {
        if (
          !canceled &&
          identity &&
          !identity.disabled_at &&
          identity.created_by !== boundAccount.accountId
        )
          setSharedName(identity.name);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [agent != null, projectId, path, threadId, boundAccount.accountId]);
  async function save() {
    if (lock.current || problem || atLimit) return;
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
          identity = await api.registerIdentity(locator);
          boundAccount.assertCurrent();
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
      setError(
        isNamedAgentLimitError(err)
          ? "Your membership's named-agent limit was reached."
          : `${err}`,
      );
      if (isNamedAgentLimitError(err)) refreshNamedAgents();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (!boundAccount.current) return null;
  return (
    <>
      <Button
        {...triggerButtonProps}
        size="small"
        aria-label={
          agent
            ? `Rename @${agent.name}`
            : sharedName
              ? "Add to my agents"
              : "Name agent"
        }
        onClick={() => {
          setName(agent?.name ?? sharedName ?? "");
          setDescription(agent?.description ?? "");
          setError("");
          setOpen(true);
        }}
      >
        {triggerLabel ??
          (agent
            ? `@${agent.name}`
            : sharedName
              ? "Add to my agents"
              : "Name agent")}
      </Button>
      <Modal
        open={open}
        title={
          modalTitle ??
          (agent
            ? "Edit agent name"
            : sharedName
              ? "Add to my agents"
              : "Name agent")
        }
        okText="Save agent name"
        confirmLoading={busy}
        okButtonProps={{ disabled: !!problem || busy || atLimit }}
        onOk={() => void save()}
        onCancel={() => {
          if (!busy) setOpen(false);
        }}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <p>
            {sharedName && !agent
              ? "This agent is shared with you. Give it a name to keep it in your sidebar; the name is yours alone. "
              : ""}
            This name is in your account across projects. Naming does not start
            work, grant communication, or make shared chat history private.
          </p>
          <NamedAgentLimitAlert directory={agent ? undefined : directory} />
          {!agent && <NamedAgentUsage directory={directory} />}
          <AgentNameInput
            id={`${id}-name`}
            value={name}
            busy={busy}
            problem={name.trim() ? problem : undefined}
            showRetirementWarning={
              !problem && isAgentNameRename(name, agent?.name)
            }
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
    </>
  );
}
