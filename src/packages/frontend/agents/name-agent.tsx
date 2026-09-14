import { useId, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Space } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { normalizeAgentName } from "@cocalc/conat/agents/personal";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { personalAgentApi, refreshNamedAgents } from "./api";
import { useBoundAgentAccount } from "./use-bound-account";

export function NameAgent({
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
  const [open, setOpen] = useState(initiallyOpen);
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  async function save() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const normalized = normalizeAgentName(name);
      const completed = await runFreshAuthAction(async () => {
        boundAccount.assertCurrent();
        const api = personalAgentApi();
        const identity = agent
          ? undefined
          : await api.registerIdentity({
              project_id: projectId,
              path,
              thread_id: threadId,
            });
        boundAccount.assertCurrent();
        await api.nameAgent({
          endpoint: agent?.endpoint ?? {
            project_id: projectId,
            agent_id: identity!.agent_id,
          },
          name: normalized,
          description,
          ...(threadTitle != null ? { thread_title: threadTitle } : {}),
          ...(projectTitle != null ? { project_title: projectTitle } : {}),
        });
      });
      if (completed) {
        refreshNamedAgents();
        setOpen(false);
      }
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
        okButtonProps={{ disabled: !name.trim() || busy }}
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
          <label htmlFor={`${id}-name`}>Agent name</label>
          <Input
            id={`${id}-name`}
            autoFocus
            value={name}
            maxLength={32}
            disabled={busy}
            aria-describedby={`${id}-help`}
            aria-invalid={!!error}
            onChange={(event) => setName(event.target.value)}
            onPressEnter={() => void save()}
          />
          <div id={`${id}-help`}>
            1-32 letters, digits or internal hyphens, beginning with a letter.
            Old names are retired after renaming.
          </div>
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
