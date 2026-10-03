/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Modal,
  Progress,
  Typography,
} from "antd";
import { TimeAgo } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { ListedConversation, PersonalStateRow } from "@cocalc/util/people";
import { conversationsChanged, peopleApi } from "./api";
import { useCollaboratorProjects } from "./new-conversation";
import { fileModified, scanProject, titleFromPath } from "./scan";

interface Found {
  project_id: string;
  path: string;
  title: string;
  add: boolean;
}

// Explicit, bounded scan of selected projects for .chat files. Nothing runs
// in the background; existing conversations get their activity refreshed and
// new files can be added.
export function ScanDialog({
  open,
  conversations,
  onClose,
}: {
  open: boolean;
  conversations: ListedConversation[];
  onClose: () => void;
}) {
  const projects = useCollaboratorProjects();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [scanned, setScanned] = useState<Map<string, number>>(new Map());
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [refreshed, setRefreshed] = useState(0);
  const [found, setFound] = useState<Found[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const canceled = useRef(false);

  useEffect(() => {
    if (!open) return;
    void peopleApi()
      .listStates({ kind: "project" })
      .then((rows: PersonalStateRow[]) =>
        setScanned(
          new Map(
            rows
              .filter((row) => row.scanned_at != null)
              .map((row) => [row.target_id, row.scanned_at!]),
          ),
        ),
      )
      .catch(() => {});
  }, [open]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? projects.filter((p) => p.title.toLowerCase().includes(q))
      : projects;
  }, [projects, filter]);

  const known = useMemo(
    () => new Set(conversations.map((c) => `${c.project_id}:${c.path}`)),
    [conversations],
  );

  async function scan() {
    const ids = projects
      .map((p) => p.project_id)
      .filter((id) => selected.has(id));
    canceled.current = false;
    setRunning(true);
    setDone(0);
    setTotal(ids.length);
    setRefreshed(0);
    setFound([]);
    setErrors([]);
    const titles = new Map(projects.map((p) => [p.project_id, p.title]));
    let next = 0;
    const worker = async () => {
      while (next < ids.length && !canceled.current) {
        const project_id = ids[next++];
        const started = Date.now();
        try {
          const result = await scanProject(project_id, scanned.get(project_id));
          const fresh: Found[] = [];
          for (const path of result.paths) {
            if (known.has(`${project_id}:${path}`)) {
              const activity = await fileModified(project_id, path);
              if (activity != null) {
                await peopleApi().refreshConversation({
                  project_id,
                  path,
                  activity,
                });
                setRefreshed((n) => n + 1);
              }
            } else {
              fresh.push({
                project_id,
                path,
                title: titleFromPath(path),
                add: true,
              });
            }
          }
          setFound((list) => [...list, ...fresh]);
          if (result.truncated) {
            setErrors((list) => [
              ...list,
              `${titles.get(project_id)}: too many files; showing the first results.`,
            ]);
          }
          await peopleApi().setState({
            kind: "project",
            target_id: project_id,
            patch: { scanned_at: started },
          });
          setScanned((map) => new Map(map).set(project_id, started));
        } catch (err) {
          setErrors((list) => [...list, `${titles.get(project_id)}: ${err}`]);
        } finally {
          setDone((n) => n + 1);
        }
      }
    };
    await Promise.all([worker(), worker()]);
    setRunning(false);
    conversationsChanged();
  }

  async function addSelected() {
    setAdding(true);
    const failures: string[] = [];
    for (const item of found.filter((f) => f.add)) {
      try {
        await peopleApi().addConversation({
          project_id: item.project_id,
          path: item.path,
          title: item.title,
        });
      } catch (err) {
        failures.push(`${item.path}: ${err}`);
      }
    }
    setAdding(false);
    conversationsChanged();
    if (failures.length) setErrors(failures);
    else {
      setFound([]);
      onClose();
    }
  }

  const projectTitle = (id: string) =>
    projects.find((p) => p.project_id === id)?.title ?? id;

  return (
    <Modal
      open={open}
      title="Scan projects for chat files"
      width={760}
      onCancel={() => {
        canceled.current = true;
        onClose();
      }}
      footer={null}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        Finds .chat files changed since you last scanned each project, without
        starting it. Conversations you already have get their latest activity;
        new files can be added below. Agent chats in ~/.local are skipped.
      </Typography.Paragraph>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <Input
          type="search"
          aria-label="Filter projects"
          placeholder="Filter projects"
          allowClear
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Checkbox
          checked={
            visible.length > 0 &&
            visible.every((p) => selected.has(p.project_id))
          }
          onChange={(e) =>
            setSelected((set) => {
              const next = new Set(set);
              for (const p of visible) {
                if (e.target.checked) next.add(p.project_id);
                else next.delete(p.project_id);
              }
              return next;
            })
          }
        >
          Select all
        </Checkbox>
      </div>
      <div
        role="group"
        aria-label="Projects to scan"
        style={{
          maxHeight: 220,
          overflowY: "auto",
          border: `1px solid ${UI_COLORS.border}`,
          borderRadius: 6,
          padding: "4px 8px",
        }}
      >
        {visible.map((p) => (
          <div
            key={p.project_id}
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <Checkbox
              checked={selected.has(p.project_id)}
              onChange={(e) =>
                setSelected((set) => {
                  const next = new Set(set);
                  if (e.target.checked) next.add(p.project_id);
                  else next.delete(p.project_id);
                  return next;
                })
              }
            >
              {p.title}
            </Checkbox>
            <span
              style={{
                marginLeft: "auto",
                color: UI_COLORS.secondary,
                fontSize: 12,
              }}
            >
              {scanned.has(p.project_id) ? (
                <>
                  scanned{" "}
                  <TimeAgo date={new Date(scanned.get(p.project_id)!)} />
                </>
              ) : (
                "never scanned"
              )}
            </span>
          </div>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          margin: "12px 0",
        }}
      >
        <Button
          type="primary"
          disabled={running || selected.size === 0}
          onClick={() => void scan()}
        >
          Scan {selected.size} {selected.size === 1 ? "project" : "projects"}
        </Button>
        {running && (
          <Button onClick={() => (canceled.current = true)}>Stop</Button>
        )}
        {total > 0 && (
          <span role="status" style={{ flex: 1 }}>
            <Progress
              percent={Math.round((100 * done) / total)}
              size="small"
              aria-label="Scan progress"
            />
            {done} of {total} scanned · {refreshed} conversations updated ·{" "}
            {found.length} new files
          </span>
        )}
      </div>
      {errors.map((error, i) => (
        <Alert key={i} type="warning" role="alert" title={error} />
      ))}
      {found.length > 0 && (
        <>
          <Typography.Title level={5}>New chat files</Typography.Title>
          <div
            role="group"
            aria-label="New chat files"
            style={{ maxHeight: 260, overflowY: "auto" }}
          >
            {found.map((item, i) => (
              <div
                key={`${item.project_id}:${item.path}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto minmax(0, 1fr) minmax(0, 1.2fr)",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 0",
                }}
              >
                <Checkbox
                  aria-label={`Add ${item.path}`}
                  checked={item.add}
                  onChange={(e) =>
                    setFound((list) =>
                      list.map((f, j) =>
                        j === i ? { ...f, add: e.target.checked } : f,
                      ),
                    )
                  }
                />
                <Input
                  aria-label={`Title for ${item.path}`}
                  value={item.title}
                  onChange={(e) =>
                    setFound((list) =>
                      list.map((f, j) =>
                        j === i ? { ...f, title: e.target.value } : f,
                      ),
                    )
                  }
                />
                <span
                  title={item.path}
                  style={{
                    color: UI_COLORS.secondary,
                    fontSize: 12,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {projectTitle(item.project_id)} · {item.path}
                </span>
              </div>
            ))}
          </div>
          <Button
            type="primary"
            style={{ marginTop: 8 }}
            loading={adding}
            disabled={running || !found.some((f) => f.add)}
            onClick={() => void addSelected()}
          >
            Add {found.filter((f) => f.add).length} as conversations
          </Button>
        </>
      )}
    </Modal>
  );
}
