/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { Alert, Modal, Radio, Space, Typography } from "antd";
import type { AgentCollaboratorAccess } from "@cocalc/util/people";
import { peopleApi } from "./api";

export const VIEW_ONLY_NOTE =
  "The creator asks collaborators to only view this agent. This is a convention, not enforced: any project collaborator can still message it, using their own credentials.";

// The creator states whether other collaborators should message an agent.
export function AgentAccessDialog({
  open,
  project_id,
  agent_id,
  name,
  onClose,
}: {
  open: boolean;
  project_id: string;
  agent_id: string;
  name: string;
  onClose: () => void;
}) {
  const [access, setAccess] = useState<AgentCollaboratorAccess>();
  const [isCreator, setIsCreator] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError("");
    setAccess(undefined);
    void peopleApi()
      .getAgentAccess({ project_id, agent_id })
      .then((result) => {
        setAccess(result?.access ?? "message");
        setIsCreator(!!result?.is_creator);
      })
      .catch((err) => setError(`${err}`));
  }, [open, project_id, agent_id]);
  async function save() {
    if (!access) return;
    setBusy(true);
    setError("");
    try {
      await peopleApi().setAgentAccess({ project_id, agent_id, access });
      onClose();
    } catch (err) {
      setError(`${err}`.replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      title={`Collaborator access for @${name}`}
      okText="Save"
      okButtonProps={{ disabled: !isCreator || !access }}
      confirmLoading={busy}
      onOk={save}
      onCancel={onClose}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        Everyone on the project can see this agent. Turns a collaborator starts
        use their own credentials. You can ask them to only view it.
      </Typography.Paragraph>
      <Radio.Group
        aria-label="Collaborator access"
        value={access}
        disabled={!isCreator}
        onChange={(e) => setAccess(e.target.value)}
      >
        <Space orientation="vertical">
          <Radio value="message">Collaborators may message this agent</Radio>
          <Radio value="view">
            Please only view (a convention, not enforced)
          </Radio>
        </Space>
      </Radio.Group>
      {!isCreator && access && (
        <Alert
          style={{ marginTop: 12 }}
          type="info"
          title="Only the agent's creator can change this."
        />
      )}
      {error && <Alert role="alert" type="error" title={error} />}
    </Modal>
  );
}
