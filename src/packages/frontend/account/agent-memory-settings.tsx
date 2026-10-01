/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Account-wide agent memory: opt-in toggle with the security disclosure,
// status, and note review/deletion. Shown on Settings > AI and from the
// Claude Code and Codex settings modals.

import { Alert, Button, Collapse, Modal, Space, Tag, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import type { AgentMemoryNote } from "@cocalc/conat/agents/memory";
import { personalAgentApi } from "@cocalc/frontend/agents/api";
import { Icon } from "@cocalc/frontend/components/icon";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

type Status = {
  enabled: boolean;
  notes: number;
  bytes: number;
  updated_at?: string;
};

// Keep in sync with the reviewed security model (agent-memory-design-v2.md).
export function AgentMemoryDisclosure() {
  return (
    <div>
      <p>
        When on, your agents (Claude and Codex) can save short notes that they
        see again in future sessions, in all of your projects.
      </p>
      <ul style={{ paddingLeft: 20 }}>
        <li>
          <b>Your memory follows you into every project.</b> A note saved while
          working in one project can appear in sessions in your other projects,
          and collaborators on those projects can see it in agent activity and
          logs. Do not use memory for anything you would not share with
          collaborators on all your projects.
        </li>
        <li>
          <b>Agents decide what to save.</b> Content an agent reads (files, web
          pages, command output, and messages from other agents, including
          collaborators' agents) can influence what it saves. A bad note can
          affect future sessions until you delete it. You can review and delete
          notes at any time.
        </li>
        <li>
          <b>It goes where your agents go.</b> When one of your agents sends a
          message that starts a turn in another agent's thread (for example a
          collaborator's agent in a shared project), that turn runs as you and
          uses your memory there. Other people's agents never get your memory:
          turns they start run as them, with their own memory.
        </li>
        <li>
          <b>Never store secrets.</b> Saves that look like credentials (keys,
          tokens, passwords) are rejected, but detection is not complete.
        </li>
        <li>
          <b>Limits.</b> At most 200 notes and 400 KB. Notes are rate-limited
          per account.
        </li>
      </ul>
      <p style={{ marginBottom: 0 }}>
        Turning memory off stops it immediately. Deleting your notes removes
        them permanently.
      </p>
    </div>
  );
}

const listeners = new Set<() => void>();
function refreshAll() {
  for (const listener of listeners) listener();
}

export function useAgentMemoryStatus() {
  const [status, setStatus] = useState<Status | undefined>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setStatus(await personalAgentApi().manageAgentMemory({ op: "status" }));
      setError("");
    } catch (err) {
      setError(`${err}`);
    }
  }, []);
  useEffect(() => {
    void load();
    listeners.add(load);
    return () => {
      listeners.delete(load);
    };
  }, [load]);
  return { status, error, refresh: refreshAll };
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

export function agentMemorySummary(status?: Status): string {
  if (!status) return "Memory";
  return status.enabled
    ? `Memory: on · ${status.notes} ${status.notes === 1 ? "note" : "notes"}`
    : "Memory: off";
}

export function AgentMemoryPanel() {
  const { status, error, refresh } = useAgentMemoryStatus();
  const [notes, setNotes] = useState<AgentMemoryNote[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError("");
    try {
      await fn();
      refresh();
      if (notes) await loadNotes();
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setBusy(false);
    }
  };
  const loadNotes = async () => {
    const result = await personalAgentApi().manageAgentMemory({ op: "list" });
    setNotes(result.notes_list ?? []);
  };

  const enable = () =>
    Modal.confirm({
      title: "Turn on agent memory (experimental)",
      width: 640,
      content: <AgentMemoryDisclosure />,
      okText: "I understand, turn it on",
      cancelText: "Cancel",
      onOk: () =>
        act(() =>
          personalAgentApi().manageAgentMemory({
            op: "set-enabled",
            enabled: true,
          }),
        ),
    });

  return (
    <Space orientation="vertical" style={{ width: "100%", maxWidth: 1000 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Agent memory lets Claude and Codex keep short notes across sessions and
        projects. It is off by default.
      </Typography.Paragraph>
      {error && <Alert type="warning" showIcon title={error} />}
      {actionError && <Alert type="error" showIcon title={actionError} />}
      {status && (
        <Space wrap>
          <Tag color={status.enabled ? "green" : "default"}>
            {status.enabled ? "On" : "Off"}
          </Tag>
          <span style={{ color: UI_COLORS.secondary }}>
            {status.notes} {status.notes === 1 ? "note" : "notes"} ·{" "}
            {formatBytes(status.bytes)}
          </span>
          {status.enabled ? (
            <Button
              disabled={busy}
              onClick={() =>
                act(() =>
                  personalAgentApi().manageAgentMemory({
                    op: "set-enabled",
                    enabled: false,
                  }),
                )
              }
            >
              Turn off
            </Button>
          ) : (
            <Button type="primary" disabled={busy} onClick={enable}>
              Turn on…
            </Button>
          )}
          <Button
            disabled={busy || !status.notes}
            onClick={() => act(loadNotes)}
          >
            Review notes
          </Button>
          <Button
            danger
            disabled={busy || !status.notes}
            onClick={() =>
              Modal.confirm({
                title: "Delete all memory notes?",
                content: "This permanently deletes every saved note.",
                okText: "Delete all",
                okButtonProps: { danger: true },
                onOk: () =>
                  act(() =>
                    personalAgentApi().manageAgentMemory({ op: "delete-all" }),
                  ),
              })
            }
          >
            Delete all notes
          </Button>
        </Space>
      )}
      {notes && (
        <Collapse
          size="small"
          items={notes.map((note) => ({
            key: note.name,
            label: (
              <span>
                <b>{note.name}</b>
                <span style={{ color: UI_COLORS.secondary }}>
                  {" "}
                  — {note.description}
                </span>
              </span>
            ),
            extra: (
              <Button
                size="small"
                type="text"
                danger
                aria-label={`Delete note ${note.name}`}
                icon={<Icon name="trash" />}
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  void act(() =>
                    personalAgentApi().manageAgentMemory({
                      op: "delete",
                      name: note.name,
                    }),
                  );
                }}
              />
            ),
            children: (
              <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                {note.body}
              </pre>
            ),
          }))}
        />
      )}
    </Space>
  );
}

/** Compact status button for the Claude Code and Codex settings modals. */
export function AgentMemoryButton() {
  const { status } = useAgentMemoryStatus();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="small"
        icon={<Icon name="database" />}
        onClick={() => setOpen(true)}
        style={
          status?.enabled
            ? { borderColor: UI_COLORS.success, color: UI_COLORS.success }
            : undefined
        }
      >
        {agentMemorySummary(status)}
      </Button>
      <Modal
        title="Agent memory"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={760}
        destroyOnHidden
      >
        <AgentMemoryPanel />
      </Modal>
    </>
  );
}
