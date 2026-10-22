/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A project's edit history and logs (conat/project/persist-storage.ts): what
they take, and deleting or trimming them to free space.  The project's users
can't reach these files; an owner (or collaborators, if an owner allows them
in the project's "Storage history" setting) can manage them here.
*/

import {
  Alert,
  Button,
  Checkbox,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { TimeAgo } from "@cocalc/frontend/components";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { human_readable_size } from "@cocalc/util/misc";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  applyPersistStorageInChunks,
  PERSIST_STORAGE_APPLY_TIMEOUT_MS,
  type PersistStorageAction,
  type PersistStorageList,
  type PersistStreamInfo,
  type PersistStreamKind,
} from "@cocalc/conat/project/persist-storage";

const { Text } = Typography;

// the streams loaded at once: enough for nearly every project, and for its
// clean-up (which then says if there are more)
const LIMIT = 2000;
const LOG_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

const KIND_LABEL: Record<PersistStreamKind, string> = {
  "edit-history": "Edit history",
  "agent-log": "Agent activity log",
  notebook: "Notebook state",
  project: "Project log",
  other: "Other",
};

// what deleting a stream of this kind loses
const KIND_LOSS: Record<PersistStreamKind, string> = {
  "edit-history":
    "its TimeTravel history (the saved file stays; unsaved changes in an open copy may be lost)",
  "agent-log":
    "the activity details of its agent turns (thinking, tool calls); the chat messages stay",
  notebook: "its saved runtime state",
  project: "this project log",
  other: "its data",
};

function canTrim(stream: PersistStreamInfo): string | undefined {
  if (stream.kind === "edit-history") return "Drop archived history";
  if (stream.kind === "agent-log" || stream.kind === "project") {
    return `Keep last ${LOG_DAYS} days`;
  }
}

function trimAction(stream: PersistStreamInfo): PersistStorageAction {
  return stream.kind === "edit-history"
    ? { op: "trim", name: stream.name, archived: true }
    : { op: "trim", name: stream.name, before: Date.now() - LOG_DAYS * DAY };
}

export default function EditHistoryStorage({
  project_id,
}: {
  project_id: string;
}) {
  const [list, setList] = useState<PersistStorageList | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanup, setCleanup] = useState({
    deleted: true,
    logs: true,
    archived: false,
  });
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    origin: "edit-history-storage",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setList(
        await webapp_client.conat_client.hub.projects.listProjectPersistStorage(
          { project_id, limit: LIMIT },
        ),
      );
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, [project_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(
    async (actions: PersistStorageAction[]) => {
      if (actions.length === 0) return;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await runFreshAuthAction(async () => {
          const result = await applyPersistStorageInChunks(
            actions,
            async (chunk) =>
              await webapp_client.conat_client.hub.projects.applyProjectPersistStorage(
                {
                  browser_id: webapp_client.browser_id,
                  project_id,
                  actions: chunk,
                  timeout: PERSIST_STORAGE_APPLY_TIMEOUT_MS,
                },
              ),
          );
          const failed = result.results.filter((r) => !r.ok);
          setNotice(
            `Freed ${human_readable_size(result.freed)}.` +
              (failed.length
                ? ` ${failed.length} failed: ${failed
                    .slice(0, 3)
                    .map((r) => `${r.name}: ${r.error}`)
                    .join("; ")}`
                : ""),
          );
        });
        await load();
      } catch (err) {
        setError(`${err}`);
      } finally {
        setBusy(false);
      }
    },
    [project_id, load, runFreshAuthAction],
  );

  const confirmDelete = (stream: PersistStreamInfo) => {
    Modal.confirm({
      title: `Delete ${KIND_LABEL[stream.kind].toLowerCase()}?`,
      content: (
        <>
          <div>
            <code>{stream.document ?? stream.name}</code> (
            {human_readable_size(stream.bytes)})
          </div>
          <div style={{ marginTop: "8px" }}>
            This deletes {KIND_LOSS[stream.kind]}. It can't be undone. Open
            documents of this project reload.
          </div>
        </>
      ),
      okText: "Delete",
      okButtonProps: { danger: true },
      onOk: () => apply([{ op: "delete", name: stream.name }]),
    });
  };

  const plan = useMemo(() => {
    const streams = list?.streams ?? [];
    const deleted = streams.filter((s) => s.document_exists === false);
    const logs = streams.filter(
      (s) =>
        (s.kind === "agent-log" || s.kind === "project") &&
        s.document_exists !== false,
    );
    const archived = streams.filter(
      (s) => s.kind === "edit-history" && s.document_exists !== false,
    );
    const sum = (x: PersistStreamInfo[]) =>
      x.reduce((total, s) => total + s.bytes, 0);
    return {
      deleted,
      logs,
      archived,
      deletedBytes: sum(deleted),
      logBytes: sum(logs),
    };
  }, [list]);

  const runCleanup = async () => {
    const actions: PersistStorageAction[] = [];
    if (cleanup.deleted) {
      for (const s of plan.deleted)
        actions.push({ op: "delete", name: s.name });
    }
    if (cleanup.logs) {
      for (const s of plan.logs) actions.push(trimAction(s));
    }
    if (cleanup.archived) {
      for (const s of plan.archived) actions.push(trimAction(s));
    }
    setCleanupOpen(false);
    await apply(actions);
  };

  if (list != null && !list.supported) return null;

  const canManage = !!list?.can_manage;
  const columns = [
    {
      title: "Belongs to",
      key: "document",
      render: (_: unknown, s: PersistStreamInfo) => (
        <Space size={6} wrap>
          <Text code style={{ wordBreak: "break-all" }}>
            {s.document ?? s.name}
          </Text>
          {s.document_exists === false && <Tag>file deleted</Tag>}
        </Space>
      ),
    },
    {
      title: "Kind",
      key: "kind",
      render: (_: unknown, s: PersistStreamInfo) => KIND_LABEL[s.kind],
    },
    {
      title: "Size",
      key: "bytes",
      sorter: (a: PersistStreamInfo, b: PersistStreamInfo) => a.bytes - b.bytes,
      defaultSortOrder: "descend" as const,
      render: (_: unknown, s: PersistStreamInfo) =>
        human_readable_size(s.bytes),
    },
    {
      title: "Last written",
      key: "modified",
      sorter: (a: PersistStreamInfo, b: PersistStreamInfo) =>
        a.modified - b.modified,
      render: (_: unknown, s: PersistStreamInfo) => (
        <TimeAgo date={new Date(s.modified)} />
      ),
    },
    ...(canManage
      ? [
          {
            title: "",
            key: "actions",
            render: (_: unknown, s: PersistStreamInfo) => (
              <Space size={4}>
                {canTrim(s) && (
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => apply([trimAction(s)])}
                  >
                    {canTrim(s)}
                  </Button>
                )}
                <Button
                  size="small"
                  danger
                  disabled={busy}
                  onClick={() => confirmDelete(s)}
                >
                  Delete
                </Button>
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      <Space style={{ marginBottom: "8px" }} wrap>
        <b>Edit history and logs</b>
        {list && (
          <Text type="secondary">
            {human_readable_size(list.total.bytes)} in {list.total.count}{" "}
            streams
          </Text>
        )}
        <Button size="small" onClick={() => void load()} loading={loading}>
          Refresh
        </Button>
        {canManage && (
          <Button
            size="small"
            disabled={busy || !list?.streams.length}
            onClick={() => setCleanupOpen(true)}
          >
            Clean up…
          </Button>
        )}
      </Space>
      <div style={{ color: UI_COLORS.secondary, marginBottom: "8px" }}>
        TimeTravel history of documents, agent activity logs and notebook state,
        kept outside the project's files.{" "}
        {list && !canManage
          ? "Only owners can delete or trim them, unless an owner allows collaborators (Settings, Storage history)."
          : "Deleting or trimming them frees space; open documents reload."}
      </div>
      {list?.by_kind && (
        <Space size={4} wrap style={{ marginBottom: "8px" }}>
          {Object.entries(list.by_kind).map(([kind, totals]) => (
            <Tag key={kind}>
              {KIND_LABEL[kind as PersistStreamKind]}:{" "}
              {human_readable_size(totals?.bytes ?? 0)}
            </Tag>
          ))}
        </Space>
      )}
      {error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: "8px" }}
          message={error}
          closable
          onClose={() => setError("")}
        />
      )}
      {notice && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: "8px" }}
          message={notice}
          closable
          onClose={() => setNotice("")}
        />
      )}
      {list?.truncated && (
        <Alert
          type="info"
          style={{ marginBottom: "8px" }}
          message="This project has more streams than shown; clean up runs on those shown."
        />
      )}
      <Table
        size="small"
        rowKey="name"
        loading={loading}
        dataSource={list?.streams ?? []}
        columns={columns}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
      />
      <Modal
        title="Clean up edit history and logs"
        open={cleanupOpen}
        okText="Clean up"
        okButtonProps={{ danger: true }}
        onOk={() => void runCleanup()}
        onCancel={() => setCleanupOpen(false)}
      >
        <Space direction="vertical">
          <Checkbox
            checked={cleanup.deleted}
            disabled={plan.deleted.length === 0}
            onChange={(e) =>
              setCleanup({ ...cleanup, deleted: e.target.checked })
            }
          >
            Delete the history of {plan.deleted.length} deleted files (
            {human_readable_size(plan.deletedBytes)})
          </Checkbox>
          <Checkbox
            checked={cleanup.logs}
            disabled={plan.logs.length === 0}
            onChange={(e) => setCleanup({ ...cleanup, logs: e.target.checked })}
          >
            Keep only the last {LOG_DAYS} days of {plan.logs.length} agent and
            project logs (now {human_readable_size(plan.logBytes)})
          </Checkbox>
          <Checkbox
            checked={cleanup.archived}
            disabled={plan.archived.length === 0}
            onChange={(e) =>
              setCleanup({ ...cleanup, archived: e.target.checked })
            }
          >
            Drop the archived history of {plan.archived.length} documents (kept
            by earlier resets of their history)
          </Checkbox>
          <Text type="secondary">
            This can't be undone. Open documents of this project reload.
          </Text>
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}
