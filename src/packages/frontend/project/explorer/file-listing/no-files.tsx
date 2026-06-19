/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import type { IconName } from "@cocalc/frontend/components/icon";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { NEW_FILETYPE_ICONS } from "@cocalc/frontend/project/new/consts";
import type { ProjectActions } from "@cocalc/frontend/project_actions";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { COLORS } from "@cocalc/util/theme";

interface Props {
  file_search: string;
  current_path: string;
  project_id: string;
  openUploadFiles?: () => void;
}

export default function NoFiles({
  file_search = "",
  current_path,
  project_id,
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
  if (
    normalizeAbsolutePath(current_path) !==
    normalizeAbsolutePath(getProjectHomeDirectory(project_id))
  ) {
    return (
      <Alert
        type="info"
        showIcon
        style={{ margin: "16px 16px 16px 0" }}
        title="This folder is empty."
        description={
          <Space wrap style={{ marginTop: 8 }}>
            <Button size="small" type="primary" onClick={openNewPage}>
              +New
            </Button>
          </Space>
        }
      />
    );
  }
  return (
    <EmptyDirectoryWelcome
      openNewPage={openNewPage}
      createFile={createFile}
      aiAllowed={aiAllowed}
      openUploadFiles={openUploadFiles}
    />
  );
}

function EmptyDirectoryWelcome({
  createFile,
  openNewPage,
  aiAllowed,
  openUploadFiles,
}: {
  createFile: (ext: string) => void;
  openNewPage: () => void;
  aiAllowed: boolean;
  openUploadFiles?: () => void;
}) {
  const actions: {
    title: string;
    description: string;
    tooltip: string;
    icon: IconName;
    color: string;
    onClick?: () => void;
    className?: string;
  }[] = [
    {
      title: "Jupyter",
      description: "Notebook",
      tooltip: "Create a notebook for code, text, plots, and results.",
      icon: NEW_FILETYPE_ICONS.ipynb,
      color: COLORS.COCALC_ORANGE,
      onClick: () => createFile("ipynb"),
    },
    ...(aiAllowed
      ? [
          {
            title: "Agents",
            description: "AI chat",
            tooltip: "Start an AI agent thread in this project.",
            icon: NEW_FILETYPE_ICONS.chat,
            color: COLORS.ANTD_LINK_BLUE,
            onClick: () => createFile("chat"),
          },
        ]
      : []),
    {
      title: "Terminal",
      description: "Shell",
      tooltip: "Open a shell in this project environment.",
      icon: NEW_FILETYPE_ICONS.term,
      color: COLORS.GRAY_D,
      onClick: () => createFile("term"),
    },
    {
      title: "Upload",
      description: "Files",
      tooltip: "Add files from your computer to this project.",
      icon: "cloud-upload",
      color: COLORS.BS_GREEN_D,
      onClick: openUploadFiles,
      className: "upload-button",
    },
    {
      title: "LaTeX",
      description: "Document",
      tooltip: "Create a LaTeX document for math-rich writing.",
      icon: NEW_FILETYPE_ICONS.tex,
      color: COLORS.BLUE_D,
      onClick: () => createFile("tex"),
    },
    {
      title: "Markdown",
      description: "Notes",
      tooltip: "Create a Markdown note, README, or project context file.",
      icon: NEW_FILETYPE_ICONS.md,
      color: COLORS.ANTD_LINK_BLUE_DARK,
      onClick: () => createFile("md"),
    },
    {
      title: "Folder",
      description: "Directory",
      tooltip: "Create a folder to organize files in this project.",
      icon: "folder",
      color: COLORS.BS_GREEN,
      onClick: () => createFile("/"),
    },
    {
      title: "Other",
      description: "More types",
      tooltip: "Open the full file creator for more file types.",
      icon: "plus-circle",
      color: COLORS.GRAY_M,
      onClick: openNewPage,
    },
  ];

  return (
    <div
      data-testid="empty-directory-welcome"
      style={{
        margin: "32px auto 28px auto",
        width: "calc(100% - 56px)",
        maxWidth: 960,
        border: `1px solid ${COLORS.GRAY_DDD}`,
        borderRadius: 16,
        overflow: "hidden",
        background: `linear-gradient(135deg, ${COLORS.BLUE_LLLL} 0%, ${COLORS.GRAY_LLL} 55%, ${COLORS.BS_GREEN_LL} 100%)`,
        boxShadow: `0 12px 32px ${COLORS.GRAY_DDD}`,
      }}
    >
      <div
        style={{
          padding: "26px 28px 10px 28px",
          textAlign: "center",
        }}
      >
        <h2
          style={{
            margin: "0 0 6px 0",
            color: COLORS.GRAY_DD,
            fontSize: 26,
            fontWeight: 700,
          }}
        >
          Welcome to your project
        </h2>
        <div
          style={{
            color: COLORS.GRAY_M,
            fontSize: 15,
            maxWidth: 620,
            margin: "0 auto",
          }}
        >
          Create a notebook, terminal, folder, or upload files to get started.
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(112px, 1fr))",
          gap: 10,
          padding: "18px 22px 22px 22px",
        }}
      >
        {actions.map((action) => (
          <Tooltip
            key={action.title}
            title={action.tooltip}
            placement="bottom"
            arrow={false}
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
                borderRadius: 12,
                padding: "12px 10px",
                minHeight: 88,
                background: "white",
                cursor: "pointer",
                boxShadow: `0 6px 18px ${COLORS.GRAY_DDD}`,
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: action.color,
                    color: "white",
                    fontSize: 16,
                  }}
                >
                  <Icon name={action.icon} />
                </span>
                <strong style={{ color: COLORS.GRAY_DD, fontSize: 15 }}>
                  {action.title}
                </strong>
              </div>
              <div
                style={{
                  color: COLORS.GRAY_M,
                  lineHeight: 1.25,
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
  );
}
