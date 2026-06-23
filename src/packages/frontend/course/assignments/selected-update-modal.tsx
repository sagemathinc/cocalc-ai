/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Checkbox, Input, Modal, Space } from "antd";
import { useEffect, useState } from "react";
import { Icon, Loading } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { CourseActions } from "../actions";
import type { AssignmentRecord } from "../store";
import type { AssignmentStatus } from "../types";
import { STUDENT_SUBDIR } from "./consts";

type SelectableAssignmentPath = {
  path: string;
  isDir: boolean;
  depth: number;
};

const MAX_SELECTABLE_PATHS = 1000;
const MAX_RECURSION_DEPTH = 8;

function joinPath(...parts: (string | undefined)[]): string {
  return parts
    .filter((part) => part != null && part !== "")
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

function sourceRootPath(assignment: AssignmentRecord): string {
  const path = assignment.get("path") ?? "";
  if (assignment.get("has_student_subdir")) {
    return joinPath(path, STUDENT_SUBDIR);
  }
  return path;
}

function compactSelectedPaths(paths: string[]): string[] {
  const sorted = Array.from(new Set(paths))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const result: string[] = [];
  for (const path of sorted) {
    if (!result.some((parent) => path.startsWith(`${parent}/`))) {
      result.push(path);
    }
  }
  return result;
}

async function loadSelectableAssignmentPaths({
  project_id,
  sourceRoot,
}: {
  project_id: string;
  sourceRoot: string;
}): Promise<SelectableAssignmentPath[]> {
  const result: SelectableAssignmentPath[] = [];

  async function walk(relDir: string, depth: number): Promise<void> {
    if (result.length > MAX_SELECTABLE_PATHS) {
      throw new Error(
        `Too many files to show at once. Narrow the assignment to fewer than ${MAX_SELECTABLE_PATHS} paths.`,
      );
    }
    if (depth > MAX_RECURSION_DEPTH) {
      return;
    }
    const { files } = await webapp_client.project_client.directory_listing({
      project_id,
      path: joinPath(sourceRoot, relDir),
      hidden: false,
    });
    const entries = files
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => {
        if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    for (const entry of entries) {
      const relPath = joinPath(relDir, entry.name);
      result.push({ path: relPath, isDir: !!entry.isDir, depth });
      if (entry.isDir && !entry.isSymLink) {
        await walk(relPath, depth + 1);
      }
    }
  }

  await walk("", 0);
  return result;
}

export function SendSelectedAssignmentFilesModal({
  open,
  onClose,
  assignment,
  actions,
  project_id,
  status,
}: {
  open: boolean;
  onClose: () => void;
  assignment: AssignmentRecord;
  actions: CourseActions;
  project_id: string;
  status: AssignmentStatus;
}) {
  const [paths, setPaths] = useState<SelectableAssignmentPath[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState<string>("");
  const [includeNotAssigned, setIncludeNotAssigned] = useState<boolean>(false);
  const [overwrite, setOverwrite] = useState<boolean>(false);
  const [overwriteConfirm, setOverwriteConfirm] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [sending, setSending] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const sourceRoot = sourceRootPath(assignment);
  const targetRoot = assignment.get("target_path");
  const assignment_id = assignment.get("assignment_id");
  const compactSelection = compactSelectedPaths(Array.from(selected));
  const targetCount = includeNotAssigned
    ? status.assignment + status.not_assignment
    : status.assignment;
  const canSend =
    compactSelection.length > 0 &&
    targetCount > 0 &&
    (!overwrite || overwriteConfirm === "OVERWRITE");
  const normalizedSearch = search.trim().toLowerCase();
  const visiblePaths = normalizedSearch
    ? paths.filter((item) => item.path.toLowerCase().includes(normalizedSearch))
    : paths;

  useEffect(() => {
    if (!open) return;
    let canceled = false;
    setLoading(true);
    setError("");
    setSelected(new Set());
    loadSelectableAssignmentPaths({ project_id, sourceRoot })
      .then((paths) => {
        if (!canceled) setPaths(paths);
      })
      .catch((err) => {
        if (!canceled) setError(`${err}`);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [open, project_id, sourceRoot]);

  function toggle(path: string, checked: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  }

  async function send(): Promise<void> {
    if (!assignment_id || !canSend) return;
    setSending(true);
    try {
      await actions.assignments.send_selected_assignment_paths_to_students({
        assignment_id,
        relative_paths: compactSelection,
        include_not_assigned: includeNotAssigned,
        overwrite,
      });
      onClose();
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Send selected assignment files"
      onCancel={onClose}
      onOk={send}
      okText={overwrite ? "Overwrite selected files" : "Send selected files"}
      okButtonProps={{ disabled: !canSend, danger: overwrite }}
      confirmLoading={sending}
      width={760}
    >
      <Alert
        type={overwrite ? "warning" : "info"}
        showIcon
        style={{ marginBottom: "12px" }}
        message={
          overwrite
            ? "Selected files will replace existing student files."
            : "Existing student files are skipped and count as successful."
        }
        description={`Source: ${sourceRoot || "/"} -> student destination: ${
          targetRoot || "/"
        }`}
      />
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Input.Search
          allowClear
          placeholder="Search assignment files..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: "4px",
            maxHeight: "320px",
            overflow: "auto",
            padding: "6px 0",
          }}
        >
          {loading ? (
            <div style={{ padding: "16px" }}>
              <Loading /> Loading assignment files...
            </div>
          ) : error ? (
            <Alert type="error" message={error} />
          ) : visiblePaths.length ? (
            visiblePaths.map((item) => (
              <label
                key={item.path}
                style={{
                  alignItems: "center",
                  cursor: "pointer",
                  display: "flex",
                  gap: "8px",
                  padding: "5px 10px",
                  paddingLeft: `${10 + item.depth * 18}px`,
                }}
              >
                <Checkbox
                  checked={selected.has(item.path)}
                  onChange={(e) => toggle(item.path, e.target.checked)}
                />
                <Icon name={item.isDir ? "folder" : "file"} />
                <code>{item.path}</code>
              </label>
            ))
          ) : (
            <div style={{ color: "#666", padding: "16px" }}>
              No assignment files found.
            </div>
          )}
        </div>
        <Space direction="vertical">
          <Checkbox
            checked={includeNotAssigned}
            onChange={(e) => setIncludeNotAssigned(e.target.checked)}
          >
            Also send to students who have not previously received this
            assignment
          </Checkbox>
          <Checkbox
            checked={overwrite}
            onChange={(e) => {
              setOverwrite(e.target.checked);
              setOverwriteConfirm("");
            }}
          >
            Overwrite existing student files
          </Checkbox>
          {overwrite ? (
            <Input
              placeholder='Type "OVERWRITE" to confirm replacing files'
              value={overwriteConfirm}
              onChange={(e) => setOverwriteConfirm(e.target.value)}
            />
          ) : undefined}
        </Space>
        <div style={{ color: "#666" }}>
          <Button
            size="small"
            onClick={() => setSelected(new Set(paths.map((item) => item.path)))}
            disabled={loading || paths.length === 0}
          >
            Select all
          </Button>{" "}
          <Button
            size="small"
            onClick={() => setSelected(new Set())}
            disabled={selected.size === 0}
          >
            Clear
          </Button>{" "}
          {compactSelection.length} path
          {compactSelection.length === 1 ? "" : "s"} selected for {targetCount}{" "}
          student
          {targetCount === 1 ? "" : "s"}.
        </div>
      </Space>
    </Modal>
  );
}
