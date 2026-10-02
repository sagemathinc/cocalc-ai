/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// "Search projects" in the sidebar: find files by name across projects, in
// parallel, recently used projects first (see file-search-runner).

import { useMemo, useRef, useState } from "react";
import { Alert, Button, Drawer, Input, Typography } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  runProjectFileSearch,
  type FileSearchOptions,
  type FileSearchProgress,
} from "./file-search-runner";

const WIDTH_KEY = "cocalc:projects-search-drawer-width";

function savedWidth(): number {
  try {
    const width = Number(localStorage.getItem(WIDTH_KEY));
    return Math.max(320, Math.min(1200, width || 520));
  } catch {
    return 520;
  }
}

// Projects to search: not deleted or archived, by this account's last use.
export function searchableProjects(project_map: any, account_id?: string) {
  const list: { id: string; used: number }[] = [];
  project_map?.forEach((project, project_id: string) => {
    if (project.get("deleted")) return;
    if (project.getIn(["state", "state"]) === "archived") return;
    const used = new Date(
      (account_id && project.getIn(["last_active", account_id])) ||
        project.get("last_edited") ||
        0,
    ).valueOf();
    list.push({ id: project_id, used: Number.isFinite(used) ? used : 0 });
  });
  return list.sort((a, b) => b.used - a.used).map(({ id }) => id);
}

export function ProjectsSearchDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const project_map = useTypedRedux("projects", "project_map");
  const account_id = useTypedRedux("account", "account_id");
  const [width, setWidth] = useState(savedWidth);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<FileSearchOptions>({
    hidden: false,
    caseSensitive: false,
    ignore: true,
  });
  const [progress, setProgress] = useState<FileSearchProgress>();
  const [searched, setSearched] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const projects = useMemo(
    () => searchableProjects(project_map, account_id),
    [project_map, account_id],
  );
  const title = (id: string) =>
    (project_map?.getIn([id, "title"]) as string | undefined) || "Untitled";

  async function run(more = false) {
    const q = more ? searched : query.trim();
    if (!q) return;
    const current = ++generation.current;
    const previous = more ? progress : undefined;
    setBusy(true);
    setSearched(q);
    if (!more) setProgress(undefined);
    const merge = (next: FileSearchProgress): FileSearchProgress =>
      previous
        ? {
            ...next,
            hits: [...previous.hits, ...next.hits],
            searched: [...previous.searched, ...next.searched],
            unavailable: [...previous.unavailable, ...next.unavailable],
            truncated: previous.truncated || next.truncated,
          }
        : next;
    const result = await runProjectFileSearch({
      project_ids: more ? (progress?.pending ?? []) : projects,
      query: q,
      options,
      canceled: () => current !== generation.current,
      report: (next) => {
        if (current === generation.current) setProgress(merge(next));
      },
    });
    if (current !== generation.current) return;
    setProgress(merge(result));
    setBusy(false);
  }

  function openHit(project_id: string, path: string) {
    void redux.getActions("projects").open_project({
      project_id,
      target: `files/${path}`,
      switch_to: true,
    });
    onClose();
  }

  const toggle = (key: keyof FileSearchOptions, label: string) => (
    <Button
      size="small"
      type={options[key] ? "primary" : "default"}
      aria-pressed={options[key]}
      onClick={() => setOptions({ ...options, [key]: !options[key] })}
    >
      {label}
    </Button>
  );

  // Hits grouped by project, in search order.
  const groups = new Map<string, string[]>();
  for (const hit of progress?.hits ?? [])
    groups.set(hit.project_id, [
      ...(groups.get(hit.project_id) ?? []),
      hit.path,
    ]);

  return (
    <Drawer
      title="Search projects"
      open={open}
      onClose={onClose}
      size={width}
      resizable={{
        onResize: (next: number) => {
          setWidth(next);
          try {
            localStorage.setItem(WIDTH_KEY, `${next}`);
          } catch {
            // the width still applies for this session
          }
        },
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Input.Search
          allowClear
          autoFocus
          aria-label="Search file names in projects"
          placeholder="File name, e.g. thesis.tex or *.ipynb"
          enterButton="Search"
          loading={busy}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onSearch={() => void run()}
        />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {toggle("hidden", "Hidden")}
          {toggle("caseSensitive", "Case sensitive")}
          {toggle("ignore", "Git ignore")}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Searches file names in each project's home directory, recently used
          projects first, several at a time and for at most 20 seconds per pass.
          Projects that do not answer in time are listed separately.
        </Typography.Text>
        {progress && (
          <div
            role="status"
            style={{ color: UI_COLORS.secondary, fontSize: 13 }}
          >
            {progress.hits.length}{" "}
            {progress.hits.length === 1 ? "file" : "files"} in {groups.size} of{" "}
            {progress.searched.length} projects searched
            {busy ? " · searching..." : ""}
            {progress.truncated ? " · some results not shown" : ""}
          </div>
        )}
        {[...groups].map(([project_id, paths]) => (
          <section key={project_id} aria-label={title(project_id)}>
            <Typography.Text
              strong
              style={{ display: "block", margin: "6px 0 2px" }}
            >
              {title(project_id)}
            </Typography.Text>
            {paths.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => openHit(project_id, path)}
                title={path}
                style={{
                  display: "flex",
                  gap: 6,
                  width: "100%",
                  alignItems: "center",
                  padding: "3px 4px",
                  border: 0,
                  background: "transparent",
                  color: UI_COLORS.link,
                  cursor: "pointer",
                  textAlign: "left",
                  font: "inherit",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                <Icon name="file" style={{ color: UI_COLORS.secondary }} />
                {path}
              </button>
            ))}
          </section>
        ))}
        {progress && !busy && progress.hits.length === 0 && (
          <Typography.Paragraph type="secondary">
            No matching files in the projects searched.
          </Typography.Paragraph>
        )}
        {progress && progress.unavailable.length > 0 && (
          <Alert
            type="warning"
            title={`${progress.unavailable.length} ${progress.unavailable.length === 1 ? "project" : "projects"} did not answer in time`}
            description={progress.unavailable.map(title).join(", ")}
          />
        )}
        {progress && !busy && progress.pending.length > 0 && (
          <Button onClick={() => void run(true)}>
            Search {progress.pending.length} more{" "}
            {progress.pending.length === 1 ? "project" : "projects"}
          </Button>
        )}
      </div>
    </Drawer>
  );
}
