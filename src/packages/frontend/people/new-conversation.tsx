/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo, useState } from "react";
import { Alert, Form, Input, Modal, Radio, Select } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import type { Conversation } from "@cocalc/util/conversations";
import { isProjectCollaboratorRole } from "@cocalc/util/project-access";
import { conversationsApi, conversationsChanged } from "./api";
import { createConversation } from "./create";

// Projects where the current account is an owner or collaborator, optionally
// restricted to those shared with another person.
export function useCollaboratorProjects(personId?: string) {
  const project_map = useTypedRedux("projects", "project_map");
  const account_id = useTypedRedux("account", "account_id");
  return useMemo(() => {
    const result: { project_id: string; title: string }[] = [];
    project_map?.forEach((project, project_id) => {
      if (project.get("deleted")) return;
      const users = project.get("users");
      if (!isProjectCollaboratorRole(users?.getIn([account_id, "group"]))) {
        return;
      }
      if (personId && !users?.has(personId)) return;
      result.push({ project_id, title: project.get("title") ?? project_id });
    });
    return result.sort((a, b) => a.title.localeCompare(b.title));
  }, [project_map, account_id, personId]);
}

export function NewConversationModal({
  open,
  personId,
  personName,
  onClose,
  onCreated,
}: {
  open: boolean;
  personId?: string;
  personName?: string;
  onClose: () => void;
  onCreated: (conversation: Conversation) => void;
}) {
  const projects = useCollaboratorProjects(personId);
  const [project_id, setProjectId] = useState<string>();
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!project_id) {
      setError("Choose a project.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const conversation =
        mode === "new"
          ? await createConversation({ project_id, title })
          : await conversationsApi().addExisting({ project_id, path, title });
      conversationsChanged();
      setTitle("");
      setPath("");
      onCreated(conversation);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={
        personName ? `New conversation with ${personName}` : "New conversation"
      }
      okText={mode === "new" ? "Create" : "Add"}
      okButtonProps={{ disabled: !project_id || !title.trim() }}
      confirmLoading={busy}
      onOk={submit}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form layout="vertical" onFinish={submit}>
        <Form.Item
          label="Project"
          htmlFor="people-new-conversation-project"
          extra={
            personName
              ? `Everyone in the project can read and join, including ${personName}.`
              : "Everyone in the project can read and join."
          }
        >
          <Select
            id="people-new-conversation-project"
            showSearch
            optionFilterProp="label"
            placeholder={
              projects.length ? "Choose a project" : "No shared projects"
            }
            value={project_id}
            onChange={setProjectId}
            options={projects.map((p) => ({
              value: p.project_id,
              label: p.title,
            }))}
          />
        </Form.Item>
        <Form.Item label="Title" htmlFor="people-new-conversation-title">
          <Input
            id="people-new-conversation-title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="Messages are stored in">
          <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
            <Radio value="new">A new chat file</Radio>
            <Radio value="existing">An existing .chat file</Radio>
          </Radio.Group>
        </Form.Item>
        {mode === "existing" && (
          <Form.Item
            label="Path of the .chat file"
            htmlFor="people-new-conversation-path"
          >
            <Input
              id="people-new-conversation-path"
              placeholder="e.g., notes/team.chat"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </Form.Item>
        )}
        {error && <Alert role="alert" type="error" title={error} />}
      </Form>
    </Modal>
  );
}
