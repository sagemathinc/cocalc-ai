/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, Modal, Segmented, Space } from "antd";
import { useMemo, useState } from "react";
import { redux } from "@cocalc/frontend/app-framework";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import type { IconName } from "@cocalc/frontend/components/icon";
import { file_associations } from "@cocalc/frontend/file-associations";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { NEW_FILETYPE_ICONS } from "@cocalc/frontend/project/new/consts";
import type { ProjectActions } from "@cocalc/frontend/project_actions";
import { capitalize, keys } from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { COLORS } from "@cocalc/util/theme";

interface Props {
  file_search: string;
  current_path: string;
  project_id: string;
  canCreateFiles?: boolean;
  openUploadFiles?: () => void;
}

export default function NoFiles({
  file_search = "",
  current_path,
  project_id,
  canCreateFiles = true,
  openUploadFiles,
}: Props) {
  let actions:
    | Pick<
        ProjectActions,
        | "ask_filename"
        | "setState"
        | "set_file_search"
        | "set_active_tab"
        | "set_current_path"
      >
    | undefined;
  let type_filter: string | null = null;
  let aiAllowed = true;
  try {
    actions = redux.getProjectActions(project_id);
    type_filter = redux.getProjectStore(project_id)?.get("type_filter") ?? null;
    aiAllowed =
      redux.getStore("projects")?.isAIAllowedByPolicy?.(project_id, "agent") ??
      true;
  } catch {
    // Allow isolated rendering in tests that use a placeholder project id.
  }

  function openNewPage() {
    actions?.set_current_path(current_path);
    actions?.set_active_tab("new");
    actions?.setState({
      ...(file_search.trim()
        ? { default_filename: file_search.trim() }
        : undefined),
    } as any);
  }

  function createFile(ext: string) {
    actions?.set_current_path(current_path);
    actions?.ask_filename(ext);
  }

  if (type_filter) {
    return (
      <Alert
        type="warning"
        showIcon
        style={{ margin: "8px 16px 0 16px" }}
        title="No files or folders match the current filter."
        description={
          <Space wrap style={{ marginTop: 8 }}>
            {type_filter && (
              <Button
                size="small"
                onClick={() =>
                  actions?.setState({ type_filter: undefined } as any)
                }
              >
                Type: {type_filter}
              </Button>
            )}
            {file_search.trim() && (
              <Button size="small" onClick={() => actions?.set_file_search("")}>
                Contains "{file_search}"
              </Button>
            )}
            <Button size="small" type="primary" onClick={openNewPage}>
              +New
            </Button>
          </Space>
        }
      />
    );
  }
  if (file_search.trim()) {
    return (
      <Alert
        type="warning"
        showIcon
        style={{ margin: "8px 16px 0 16px" }}
        title="No files or folders match the current filter."
        description={
          <Space wrap style={{ marginTop: 8 }}>
            <Button size="small" onClick={() => actions?.set_file_search("")}>
              Clear filter
            </Button>
            <Button size="small" type="primary" onClick={openNewPage}>
              +New
            </Button>
          </Space>
        }
      />
    );
  }
  const isProjectHome =
    normalizeAbsolutePath(current_path) ===
    normalizeAbsolutePath(getProjectHomeDirectory(project_id));

  return (
    <EmptyDirectoryWelcome
      openNewPage={openNewPage}
      createFile={createFile}
      aiAllowed={aiAllowed}
      canCreateFiles={canCreateFiles}
      openUploadFiles={openUploadFiles}
      context={isProjectHome ? "project" : "folder"}
    />
  );
}

type EmptyDirectoryContext = "project" | "folder";

function EmptyDirectoryWelcome({
  createFile,
  openNewPage,
  aiAllowed,
  canCreateFiles,
  openUploadFiles,
  context,
}: {
  createFile: (ext: string) => void;
  openNewPage: () => void;
  aiAllowed: boolean;
  canCreateFiles: boolean;
  openUploadFiles?: () => void;
  context: EmptyDirectoryContext;
}) {
  const [showMoreFileTypes, setShowMoreFileTypes] = useState(false);
  const heading = context === "project" ? "No files yet" : "This folder is empty";
  const description =
    context === "project"
      ? "Create a notebook, terminal, folder, or upload files to get started."
      : "Create a notebook, terminal, folder, or upload files here.";
  const actions: {
    title: string;
    description: string;
    tooltip: string;
    icon: IconName;
    onClick?: () => void;
    className?: string;
  }[] = [
    {
      title: "Notebook",
      description: "Jupyter",
      tooltip: "Create a Jupyter notebook for code, text, plots, and results.",
      icon: NEW_FILETYPE_ICONS.ipynb,
      onClick: () => createFile("ipynb"),
    },
    ...(aiAllowed
      ? [
          {
            title: "Agents",
            description: "AI chat",
            tooltip: "Start an AI agent thread in this project.",
            icon: NEW_FILETYPE_ICONS.chat,
            onClick: () => createFile("chat"),
          },
        ]
      : []),
    {
      title: "Terminal",
      description: "Shell",
      tooltip: "Open a shell in this project environment.",
      icon: NEW_FILETYPE_ICONS.term,
      onClick: () => createFile("term"),
    },
    {
      title: "Upload",
      description: "Files",
      tooltip: "Add files from your computer to this project.",
      icon: "cloud-upload",
      onClick: openUploadFiles ?? openNewPage,
      className: "upload-button",
    },
    {
      title: "LaTeX",
      description: "Document",
      tooltip: "Create a LaTeX document for math-rich writing.",
      icon: NEW_FILETYPE_ICONS.tex,
      onClick: () => createFile("tex"),
    },
    {
      title: "Markdown",
      description: "Notes",
      tooltip: "Create a Markdown note, README, or project context file.",
      icon: NEW_FILETYPE_ICONS.md,
      onClick: () => createFile("md"),
    },
    {
      title: "Folder",
      description: "Directory",
      tooltip: "Create a folder to organize files in this project.",
      icon: NEW_FILETYPE_ICONS["/"],
      onClick: () => createFile("/"),
    },
    {
      title: "More",
      description: "File types",
      tooltip: canCreateFiles
        ? "Choose from more file types without leaving this page."
        : "Open the guarded file creator for more file types.",
      icon: "plus-circle",
      onClick: canCreateFiles ? () => setShowMoreFileTypes(true) : openNewPage,
    },
  ];

  return (
    <>
      <div
        data-testid="empty-directory-welcome"
        style={{
          margin: "26px auto",
          width: "calc(100% - 48px)",
          maxWidth: 900,
          textAlign: "center",
        }}
      >
        <div
          style={{
            marginBottom: 14,
          }}
        >
          <h2
            style={{
              margin: "0 0 4px 0",
              color: COLORS.GRAY_DD,
              fontSize: 22,
              fontWeight: 600,
            }}
          >
            {heading}
          </h2>
          <div
            style={{
              color: COLORS.GRAY_M,
              fontSize: 14,
              maxWidth: 520,
              margin: "0 auto",
            }}
          >
            {description}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))",
            gap: 8,
          }}
        >
          {actions.map((action) => (
            <Tooltip
              key={action.title}
              title={action.tooltip}
              placement="bottom"
              mouseEnterDelay={0.35}
            >
              <button
                aria-label={action.tooltip}
                className={action.className}
                onClick={action.onClick}
                type="button"
                style={{
                  textAlign: "center",
                  border: `1px solid ${COLORS.GRAY_DDD}`,
                  borderRadius: 8,
                  padding: "10px 8px",
                  minHeight: 76,
                  background: "white",
                  cursor: "pointer",
                  boxShadow: `0 2px 8px ${COLORS.GRAY_LLL}`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 7,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: COLORS.BLUE_LLLL,
                      border: `1px solid ${COLORS.BLUE_LLL}`,
                      color: COLORS.BLUE_DD,
                      fontSize: 15,
                    }}
                  >
                    <Icon name={action.icon} />
                  </span>
                  <strong style={{ color: COLORS.GRAY_DD, fontSize: 14 }}>
                    {action.title}
                  </strong>
                </div>
                <div
                  style={{
                    color: COLORS.GRAY_M,
                    lineHeight: 1.2,
                    fontSize: 12,
                  }}
                >
                  {action.description}
                </div>
              </button>
            </Tooltip>
          ))}
        </div>
      </div>
      <MoreFileTypesModal
        createFile={createFile}
        onClose={() => setShowMoreFileTypes(false)}
        open={showMoreFileTypes}
      />
    </>
  );
}

interface MoreFileType {
  ext: string;
  icon: IconName;
  label: string;
}

type MoreFileTypeSort = "recommended" | "alphabetical";
type MoreFileTypeView = "grid" | "list";

const PRIMARY_EMPTY_ACTIONS = new Set([
  "/",
  "chat",
  "ipynb",
  "md",
  "term",
  "tex",
]);
const PREFERRED_MORE_FILE_TYPES = [
  "py",
  "r",
  "jl",
  "sage",
  "qmd",
  "rmd",
  "slides",
  "board",
  "tasks",
  "course",
  "csv",
  "json",
  "html",
];

function buildMoreFileTypes(): MoreFileType[] {
  const ordered = [
    ...PREFERRED_MORE_FILE_TYPES,
    ...keys(file_associations).sort(),
  ];
  const seenExt = new Set<string>();
  const seenLabel = new Set<string>();
  const types: MoreFileType[] = [];

  for (let ext of ordered) {
    if (PRIMARY_EMPTY_ACTIONS.has(ext)) continue;
    const association = file_associations[ext];
    if (association?.exclude_from_menu) continue;
    const value = association?.ext ?? ext;
    if (!value || PRIMARY_EMPTY_ACTIONS.has(value) || seenExt.has(value)) {
      continue;
    }
    const info = file_associations[value] ?? association;
    const label = capitalize(info?.name ?? value);
    const dedupeKey = label.toLowerCase();
    if (seenLabel.has(dedupeKey)) continue;
    seenExt.add(value);
    seenLabel.add(dedupeKey);
    types.push({
      ext: value,
      icon: (info?.icon ?? "file") as IconName,
      label,
    });
  }

  return types;
}

function MoreFileTypesModal({
  createFile,
  onClose,
  open,
}: {
  createFile: (ext: string) => void;
  onClose: () => void;
  open: boolean;
}) {
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<MoreFileTypeSort>("recommended");
  const [viewMode, setViewMode] = useState<MoreFileTypeView>("grid");
  const fileTypes = useMemo(() => buildMoreFileTypes(), []);
  const sortedFileTypes = useMemo(() => {
    if (sortMode === "recommended") return fileTypes;
    return [...fileTypes].sort(
      (a, b) => a.label.localeCompare(b.label) || a.ext.localeCompare(b.ext),
    );
  }, [fileTypes, sortMode]);
  const query = search.trim().toLowerCase();
  const filtered = query
    ? sortedFileTypes.filter(
        ({ ext, label }) =>
          label.toLowerCase().includes(query) ||
          ext.toLowerCase().includes(query),
      )
    : sortedFileTypes;

  function createAndClose(ext: string) {
    createFile(ext);
    setSearch("");
    onClose();
  }

  return (
    <Modal
      footer={null}
      open={open}
      onCancel={() => {
        setSearch("");
        onClose();
      }}
      title="More file types"
      width={680}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Input
          allowClear
          aria-label="Search file types"
          placeholder="Search file types..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          style={{ flex: "1 1 220px", minWidth: 220 }}
        />
        <Segmented
          aria-label="Sort file types"
          options={[
            { label: "Recommended", value: "recommended" },
            { label: "A-Z", value: "alphabetical" },
          ]}
          value={sortMode}
          onChange={(value) => setSortMode(value as MoreFileTypeSort)}
        />
        <Segmented
          aria-label="View file types"
          options={[
            { label: "Grid", value: "grid" },
            { label: "List", value: "list" },
          ]}
          value={viewMode}
          onChange={(value) => setViewMode(value as MoreFileTypeView)}
        />
      </div>
      <div
        data-testid="more-file-types-list"
        style={{
          display: "grid",
          gridTemplateColumns:
            viewMode === "grid"
              ? "repeat(auto-fit, minmax(130px, 1fr))"
              : "1fr",
          gap: 8,
          maxHeight: 360,
          overflowY: "auto",
          paddingRight: 2,
        }}
      >
        {filtered.map((type) => (
          <button
            aria-label={`Create ${type.label}`}
            key={type.ext}
            onClick={() => createAndClose(type.ext)}
            type="button"
            style={{
              alignItems: "center",
              background: "white",
              border: `1px solid ${COLORS.GRAY_DDD}`,
              borderRadius: 8,
              cursor: "pointer",
              display: "flex",
              gap: 8,
              minHeight: 46,
              padding: "8px 10px",
              textAlign: "left",
            }}
          >
            <Icon name={type.icon} />
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  color: COLORS.GRAY_DD,
                  display: "block",
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {type.label}
              </span>
              <span style={{ color: COLORS.GRAY_M, fontSize: 12 }}>
                .{type.ext}
              </span>
            </span>
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <div style={{ color: COLORS.GRAY_M, padding: "18px 0" }}>
          No file types match that search.
        </div>
      ) : null}
    </Modal>
  );
}
