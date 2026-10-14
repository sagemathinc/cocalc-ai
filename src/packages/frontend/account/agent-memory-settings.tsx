/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Account-wide agent memory: opt-in toggle with the security disclosure,
// status, export, namespaces (and the projects that see them), and note
// review. Shown on Settings > AI and from the Claude Code and Codex settings
// modals.

import {
  Alert,
  Button,
  Collapse,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useState } from "react";
import {
  AGENT_MEMORY_GLOBAL,
  AGENT_MEMORY_UNUSED_DAYS,
  isUnusedMemoryNote,
  memoryRef,
  type AgentMemoryNoteSummary,
  type AgentMemoryStatus,
} from "@cocalc/conat/agents/memory";
import { personalAgentApi } from "@cocalc/frontend/agents/api";
import { Icon } from "@cocalc/frontend/components/icon";
import { Tooltip } from "@cocalc/frontend/components/tip";
import { SelectProject } from "@cocalc/frontend/projects/select-project";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

type Status = AgentMemoryStatus;

// Keep in sync with the reviewed security model (agent-memory-design-v2.md).
export function AgentMemoryDisclosure() {
  return (
    <div>
      <p>
        When on, your agents can save short notes that they see again in future
        sessions. This includes Claude and Codex, and any other agent runtime
        you set up that can run the CoCalc CLI.
      </p>
      <ul style={{ paddingLeft: 20 }}>
        <li>
          <b>Global notes follow you into every project.</b> A global note can
          appear in sessions in all your projects, and collaborators on those
          projects can see it in agent activity, logs and conversations. Notes
          in a namespace appear only in the projects you attach to it; a project
          with no namespace sees only your global notes. Do not save anything
          you would not share with the collaborators of the projects that can
          see it.
        </li>
        <li>
          <b>Agents decide what to save.</b> Content an agent reads (files, web
          pages, command output, and messages from other agents, including
          collaborators' agents) can influence what it saves. A bad note can
          affect future sessions until you delete it. You can review and delete
          notes at any time.
        </li>
        <li>
          <b>It goes where your agents go.</b> When one of your agents starts a
          turn in another agent's thread in a project you both belong to, that
          turn runs as you and uses your memory there. Other people's agents
          read and save their own memory, not yours, but they can see anything
          from your memory that already appeared in projects or conversations
          you share with them.
        </li>
        <li>
          <b>Never store secrets.</b> Saves that look like credentials (keys,
          tokens, passwords) are rejected, but detection is not complete.
        </li>
        <li>
          <b>Limits.</b> At most 2,000 notes (500 per namespace) and 8 MB. Each
          turn lists only the most relevant notes; agents search for the rest.
          Agent use of memory is rate-limited per account.
        </li>
      </ul>
      <p style={{ marginBottom: 0 }}>
        Turning memory off stops new reads and saves right away; notes already
        loaded into a turn that is running stay in that turn. Deleting notes
        removes them from your memory, but not copies that already appeared in
        project chats, logs or backups.
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
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function agentMemorySummary(status?: Status): string {
  if (!status) return "Memory";
  return status.enabled
    ? `Memory: on · ${status.notes} ${status.notes === 1 ? "note" : "notes"}`
    : "Memory: off";
}

function download(markdown: string) {
  const name = `agent-memory-${new Date().toISOString().slice(0, 10)}.md`;
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(
    new Blob([markdown], { type: "text/markdown" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AgentMemoryPanel() {
  const { status, error, refresh } = useAgentMemoryStatus();
  const [notes, setNotes] = useState<AgentMemoryNoteSummary[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const api = () => personalAgentApi();

  const loadNotes = async () => {
    const result = await api().manageAgentMemory({ op: "list" });
    setNotes(result.notes_list ?? []);
  };
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

  const enable = () =>
    Modal.confirm({
      title: "Turn on agent memory (experimental)",
      width: 640,
      content: <AgentMemoryDisclosure />,
      okText: "I understand, turn it on",
      cancelText: "Cancel",
      onOk: () =>
        act(() =>
          api().manageAgentMemory({ op: "set-enabled", enabled: true }),
        ),
    });

  return (
    <Space orientation="vertical" style={{ width: "100%", maxWidth: 1000 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Agent memory lets Claude and Codex keep short notes across sessions.
        Global notes are seen in every project; notes in a namespace only in the
        projects you attach to it. It is off by default.
      </Typography.Paragraph>
      {error && (
        <Alert
          type="warning"
          showIcon
          title={error}
          action={
            <Button
              size="small"
              danger
              disabled={busy}
              onClick={() =>
                Modal.confirm({
                  title: "Reset agent memory?",
                  content:
                    "Your saved memory could not be read. Resetting deletes all notes.",
                  okText: "Reset",
                  okButtonProps: { danger: true },
                  onOk: () =>
                    act(() => api().manageAgentMemory({ op: "delete-all" })),
                })
              }
            >
              Reset memory
            </Button>
          }
        />
      )}
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
                  api().manageAgentMemory({
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
          <Tooltip title="Download every note as one Markdown file">
            <Button
              icon={<Icon name="download" />}
              disabled={busy || !status.notes}
              onClick={() =>
                act(async () => {
                  const { markdown } = await api().manageAgentMemory({
                    op: "export",
                  });
                  download(markdown);
                })
              }
            >
              Export
            </Button>
          </Tooltip>
          <Button
            danger
            disabled={busy || !status.notes}
            onClick={() =>
              Modal.confirm({
                title: "Delete all memory notes?",
                content:
                  "This permanently deletes every saved note, in every namespace.",
                okText: "Delete all",
                okButtonProps: { danger: true },
                onOk: () =>
                  act(() => api().manageAgentMemory({ op: "delete-all" })),
              })
            }
          >
            Delete all notes
          </Button>
        </Space>
      )}
      {status && <Namespaces status={status} busy={busy} act={act} />}
      {notes && status && (
        <Notes notes={notes} status={status} busy={busy} act={act} />
      )}
    </Space>
  );
}

type Act = (fn: () => Promise<unknown>) => Promise<void>;

function Namespaces({
  status,
  busy,
  act,
}: {
  status: Status;
  busy: boolean;
  act: Act;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const namespaces = status.namespaces ?? [];
  const projects = status.projects ?? {};
  const api = () => personalAgentApi();

  // Which projects see a namespace, and how to change that one project at a time.
  const attached = (ns: string) =>
    Object.entries(projects)
      .filter(([, list]) => list.includes(ns))
      .map(([project_id]) => project_id);
  const setAttached = (ns: string, next: string[]) =>
    act(async () => {
      const before = new Set(attached(ns));
      const after = new Set(next);
      for (const project_id of new Set([...before, ...after])) {
        if (before.has(project_id) === after.has(project_id)) continue;
        const list = projects[project_id] ?? [];
        await api().manageAgentMemory({
          op: "set-project-namespaces",
          project_id,
          namespaces: after.has(project_id)
            ? [...list, ns]
            : list.filter((n) => n !== ns),
        });
      }
    });

  return (
    <Collapse
      size="small"
      items={[
        {
          key: "namespaces",
          label: (
            <span>
              Namespaces{" "}
              <span style={{ color: UI_COLORS.secondary }}>
                ({namespaces.length}; {status.global_notes ?? 0} global notes)
              </span>
            </span>
          ),
          children: (
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Typography.Text type="secondary">
                A namespace keeps notes about one area of work (for example one
                product) out of unrelated projects. Its description helps agents
                decide where a note belongs. Several projects can share a
                namespace, and a project can have several.
              </Typography.Text>
              {namespaces.map((ns) => (
                <div
                  key={ns.name}
                  style={{
                    borderTop: `1px solid ${UI_COLORS.border}`,
                    paddingTop: 8,
                  }}
                >
                  <Space wrap style={{ width: "100%" }}>
                    <b>{ns.name}</b>
                    <span style={{ color: UI_COLORS.secondary }}>
                      {ns.notes} {ns.notes === 1 ? "note" : "notes"}
                    </span>
                    <Input
                      size="small"
                      style={{ width: 360 }}
                      placeholder="Description (optional)"
                      aria-label={`Description of ${ns.name}`}
                      value={drafts[ns.name] ?? ns.description ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        setDrafts({ ...drafts, [ns.name]: e.target.value })
                      }
                      onBlur={() => {
                        const value = drafts[ns.name];
                        if (value == null || value === (ns.description ?? ""))
                          return;
                        void act(() =>
                          api().manageAgentMemory({
                            op: "namespace-save",
                            name: ns.name,
                            description: value,
                          }),
                        );
                      }}
                    />
                    <Button
                      size="small"
                      type="text"
                      danger
                      aria-label={`Delete namespace ${ns.name}`}
                      icon={<Icon name="trash" />}
                      disabled={busy}
                      onClick={() =>
                        Modal.confirm({
                          title: `Delete namespace ${ns.name}?`,
                          content: `This permanently deletes its ${ns.notes} ${ns.notes === 1 ? "note" : "notes"}. To keep them, move them to global or another namespace first.`,
                          okText: "Delete",
                          okButtonProps: { danger: true },
                          onOk: () =>
                            act(() =>
                              api().manageAgentMemory({
                                op: "namespace-delete",
                                name: ns.name,
                              }),
                            ),
                        })
                      }
                    />
                  </Space>
                  <SelectProject
                    multiple
                    fullCollaboratorOnly
                    style={{ marginTop: 6 }}
                    placeholder="Projects that see this namespace"
                    ariaLabel={`Projects that see ${ns.name}`}
                    value={attached(ns.name)}
                    disabled={busy}
                    onChange={(next) => setAttached(ns.name, next)}
                  />
                </div>
              ))}
              <Space wrap>
                <Input
                  size="small"
                  style={{ width: 180 }}
                  placeholder="new-namespace"
                  aria-label="New namespace name"
                  value={name}
                  onChange={(e) => setName(e.target.value.trim().toLowerCase())}
                />
                <Input
                  size="small"
                  style={{ width: 360 }}
                  placeholder="Description (optional)"
                  aria-label="New namespace description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <Button
                  size="small"
                  disabled={busy || !name}
                  onClick={() =>
                    act(async () => {
                      await api().manageAgentMemory({
                        op: "namespace-save",
                        name,
                        description,
                      });
                      setName("");
                      setDescription("");
                    })
                  }
                >
                  Add namespace
                </Button>
              </Space>
            </Space>
          ),
        },
      ]}
    />
  );
}

function NoteBody({ note }: { note: AgentMemoryNoteSummary }) {
  const [body, setBody] = useState<string | undefined>();
  const [error, setError] = useState("");
  useEffect(() => {
    personalAgentApi()
      .manageAgentMemory({
        op: "read",
        namespace: note.namespace,
        name: note.name,
      })
      .then((full: any) => setBody(full.body))
      .catch((err: unknown) => setError(`${err}`));
  }, [note.namespace, note.name, note.updated_at]);
  if (error) return <Alert type="error" showIcon title={error} />;
  return <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{body ?? "…"}</pre>;
}

function Notes({
  notes,
  status,
  busy,
  act,
}: {
  notes: AgentMemoryNoteSummary[];
  status: Status;
  busy: boolean;
  act: Act;
}) {
  const [filter, setFilter] = useState("");
  const api = () => personalAgentApi();
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = notes.filter((note) => {
    const text =
      `${note.namespace}/${note.name} ${note.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const groups = [
    AGENT_MEMORY_GLOBAL,
    ...(status.namespaces ?? []).map((ns) => ns.name),
  ];
  const moveOptions = groups.map((ns) => ({
    value: ns,
    label: ns === AGENT_MEMORY_GLOBAL ? "global (every project)" : ns,
  }));
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Input
        allowClear
        placeholder="Filter notes by name or description"
        aria-label="Filter notes"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {groups.map((ns) => {
        const inGroup = shown
          .filter((note) => note.namespace === ns)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!inGroup.length) return null;
        return (
          <div key={ns}>
            <Typography.Text strong>
              {ns === AGENT_MEMORY_GLOBAL ? "Global (every project)" : ns}
            </Typography.Text>{" "}
            <span style={{ color: UI_COLORS.secondary }}>
              ({inGroup.length})
            </span>
            <Collapse
              size="small"
              destroyOnHidden
              items={inGroup.map((note) => ({
                key: memoryRef(note.namespace, note.name, true),
                label: (
                  <span>
                    <b>{note.name}</b>
                    <span style={{ color: UI_COLORS.secondary }}>
                      {" "}
                      — {note.description}
                    </span>{" "}
                    {isUnusedMemoryNote(note) && (
                      <Tooltip
                        title={`Not read or changed by an agent in ${AGENT_MEMORY_UNUSED_DAYS} days`}
                      >
                        <Tag>unused</Tag>
                      </Tooltip>
                    )}
                  </span>
                ),
                extra: (
                  <Space size={4} onClick={(event) => event.stopPropagation()}>
                    {groups.length > 1 && (
                      <Select
                        size="small"
                        style={{ width: 150 }}
                        aria-label={`Move note ${note.name}`}
                        placeholder="Move to…"
                        value={null}
                        disabled={busy}
                        options={moveOptions.filter(
                          (option) => option.value !== note.namespace,
                        )}
                        onChange={(to: string) =>
                          act(() =>
                            api().manageAgentMemory({
                              op: "move",
                              namespace: note.namespace,
                              name: note.name,
                              to,
                            }),
                          )
                        }
                      />
                    )}
                    <Button
                      size="small"
                      type="text"
                      danger
                      aria-label={`Delete note ${note.name}`}
                      icon={<Icon name="trash" />}
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          api().manageAgentMemory({
                            op: "delete",
                            namespace: note.namespace,
                            name: note.name,
                          }),
                        )
                      }
                    />
                  </Space>
                ),
                children: <NoteBody note={note} />,
              }))}
            />
          </div>
        );
      })}
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
