/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Start a direct conversation: with collaborators directly, or with anyone
// by their exact username (they get a message request).

import { useEffect, useState } from "react";
import { Alert, Button, Form, Input, Modal, Select, Space } from "antd";
import { MarkdownInput } from "@cocalc/frontend/editors/markdown-input";
import {
  MAX_DIRECT_MEMBERS,
  type MemberDirectConversation,
} from "@cocalc/util/direct-conversations";
import { peopleApi } from "./api";
import { usePeople } from "./collaborators";
import { directChanged } from "./use-direct";

export function NewDirectModal({
  open,
  personId,
  onClose,
  onStarted,
}: {
  open: boolean;
  personId?: string;
  onClose: () => void;
  onStarted: (conversation: MemberDirectConversation) => void;
}) {
  const people = usePeople();
  const [to, setTo] = useState<string[]>([]);
  // People found by username, who aren't in the collaborator list. They are
  // sent as usernames: the server accepts account ids for collaborators only.
  const [found, setFound] = useState<
    { account_id: string; name: string; username: string }[]
  >([]);
  const [username, setUsername] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uploads, setUploads] = useState(0);

  useEffect(() => {
    if (!open) return;
    setTo(personId ? [personId] : []);
    setFound([]);
    setUsername("");
    setTitle("");
    setBody("");
    setError("");
  }, [open, personId]);

  const options = [
    ...people.map((p) => ({ value: p.account_id, label: p.name })),
    ...found
      .filter((f) => !people.some((p) => p.account_id === f.account_id))
      .map((f) => ({
        value: f.account_id,
        label: `${f.name} (message request)`,
      })),
  ];
  const full = to.length >= MAX_DIRECT_MEMBERS - 1;

  async function find() {
    setError("");
    const result = await peopleApi().findDirectRecipient({ username });
    if (result == null) {
      setError(`No one has the username "${username.replace(/^@/, "")}".`);
      return;
    }
    setFound((list) => [...list, result]);
    setTo((ids) =>
      ids.includes(result.account_id) ? ids : [...ids, result.account_id],
    );
    setUsername("");
  }

  async function start() {
    setBusy(true);
    setError("");
    try {
      const collaborators = new Set(people.map((p) => p.account_id));
      const usernames = to
        .filter((id) => !collaborators.has(id))
        .map((id) => found.find((f) => f.account_id === id)?.username)
        .filter((name): name is string => !!name);
      const conversation = await peopleApi().startDirect({
        member_ids: to.filter((id) => collaborators.has(id)),
        usernames,
        title: to.length > 1 ? title : null,
        body,
      });
      directChanged();
      onStarted(conversation);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="New message"
      okText="Send"
      okButtonProps={{
        disabled: to.length === 0 || !body.trim() || uploads > 0,
      }}
      confirmLoading={busy}
      onOk={start}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form layout="vertical">
        <Form.Item
          label="To"
          htmlFor="people-new-direct-to"
          extra={`Collaborators, up to ${MAX_DIRECT_MEMBERS - 1}. No shared project needed.`}
        >
          <Select
            id="people-new-direct-to"
            aria-label="To"
            mode="multiple"
            value={to}
            onChange={(ids) => setTo(ids.slice(0, MAX_DIRECT_MEMBERS - 1))}
            options={options}
            optionFilterProp="label"
            placeholder="Choose people"
          />
        </Form.Item>
        <Form.Item
          label="Or someone else, by username"
          htmlFor="people-new-direct-username"
          extra="People who aren't your collaborators get a message request they can accept or decline."
        >
          <Space.Compact style={{ width: "100%" }}>
            <Input
              id="people-new-direct-username"
              placeholder="@username"
              value={username}
              disabled={full}
              onChange={(e) => setUsername(e.target.value)}
              onPressEnter={() => username.trim() && void find()}
            />
            <Button
              disabled={!username.trim() || full}
              onClick={() => void find()}
            >
              Add
            </Button>
          </Space.Compact>
        </Form.Item>
        {to.length > 1 && (
          <Form.Item label="Title (optional)" htmlFor="people-new-direct-title">
            <Input
              id="people-new-direct-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Form.Item>
        )}
        <Form.Item label="Message">
          <div aria-label="Message">
            <MarkdownInput
              value={body}
              onChange={setBody}
              enableUpload
              onUploadStart={() => setUploads((n) => n + 1)}
              onUploadEnd={() => setUploads((n) => Math.max(0, n - 1))}
              onShiftEnter={() => {
                if (to.length > 0 && body.trim()) void start();
              }}
              autoGrow
              autoGrowMaxHeight={240}
              compact
            />
          </div>
        </Form.Item>
        {error && <Alert type="error" role="alert" title={error} />}
      </Form>
    </Modal>
  );
}
