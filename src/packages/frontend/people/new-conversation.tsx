/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Form, Input, Modal, Radio, Select } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { Conversation } from "@cocalc/util/people";
import { isProjectCollaboratorRole } from "@cocalc/util/project-access";
import { SelectProject } from "@cocalc/frontend/projects/select-project";
import { peopleApi, conversationsChanged } from "./api";
import { createConversation } from "./create";

// Projects where the current account is an owner or collaborator, optionally
// restricted to those where another person is one too (not a viewer: a
// conversation can only be with full collaborators).
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
      if (
        personId &&
        !isProjectCollaboratorRole(users?.getIn([personId, "group"]))
      ) {
        return;
      }
      result.push({ project_id, title: project.get("title") ?? project_id });
    });
    return result.sort((a, b) => a.title.localeCompare(b.title));
  }, [project_map, account_id, personId]);
}

// The other owners and collaborators of a project, by name: who a
// conversation in it can be with.
export function useProjectPeople(project_id?: string) {
  const project_map = useTypedRedux("projects", "project_map");
  const account_id = useTypedRedux("account", "account_id");
  return useMemo(() => {
    const users = project_id
      ? project_map?.getIn([project_id, "users"])
      : undefined;
    const result: { account_id: string; name: string }[] = [];
    (users as any)?.forEach((user, id: string) => {
      if (id === account_id) return;
      if (!isProjectCollaboratorRole(user?.get?.("group"))) return;
      const name = redux.getStore("users")?.get_name(id) ?? "";
      result.push({ account_id: id, name: name.trim() || "Unknown person" });
    });
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }, [project_map, account_id, project_id]);
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
  // With a person, only projects where they are a full collaborator too.
  const sharedWithPerson = useCallback(
    (project: any) =>
      !personId || isProjectCollaboratorRole(project.users?.[personId]?.group),
    [personId],
  );
  const [project_id, setProjectId] = useState<string>();
  const people = useProjectPeople(project_id);
  // Who it is with besides you; started from a person, them.
  const [member_ids, setMemberIds] = useState<string[]>(
    personId ? [personId] : [],
  );
  // Each opening starts over: the modal stays mounted, and a project chosen
  // for one person may not be shared with the next.
  useEffect(() => {
    if (!open) return;
    setProjectId(undefined);
    setMemberIds(personId ? [personId] : []);
  }, [open, personId]);
  // Only people in the chosen project can be in it.
  useEffect(() => {
    if (!project_id) return;
    const inProject = new Set(people.map((p) => p.account_id));
    setMemberIds((ids) => ids.filter((id) => inProject.has(id)));
  }, [project_id, people]);
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
          ? await createConversation({ project_id, title, member_ids })
          : await peopleApi().addConversation({
              project_id,
              path,
              title,
              member_ids,
            });
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
          <SelectProject
            id="people-new-conversation-project"
            ariaLabel="Project"
            fullCollaboratorOnly
            filter={sharedWithPerson}
            placeholder={
              projects.length ? "Choose a project" : "No shared projects"
            }
            value={project_id ?? null}
            onChange={setProjectId}
          />
        </Form.Item>
        <Form.Item
          label="With"
          htmlFor="people-new-conversation-with"
          extra={
            mode === "new"
              ? "They are notified of new messages and see it in For you."
              : "They see it in For you. In an existing file they are notified once they write in a thread or are @mentioned."
          }
        >
          <Select
            id="people-new-conversation-with"
            aria-label="With"
            mode="multiple"
            disabled={!project_id}
            placeholder={
              project_id ? "Choose people" : "Choose a project first"
            }
            value={member_ids}
            onChange={setMemberIds}
            optionFilterProp="label"
            options={people.map((p) => ({
              value: p.account_id,
              label: p.name,
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
