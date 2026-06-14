/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
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
}

export default function NoFiles({
  file_search = "",
  current_path,
  project_id,
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
        style={{ margin: "8px 16px 0 16px" }}
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
    />
  );
}

function EmptyDirectoryWelcome({
  createFile,
  openNewPage,
  aiAllowed,
}: {
  createFile: (ext: string) => void;
  openNewPage: () => void;
  aiAllowed: boolean;
}) {
  const actions: {
    title: string;
    description: string;
    icon: IconName;
    color: string;
    onClick?: () => void;
    className?: string;
  }[] = [
    {
      title: "Jupyter Notebook",
      description: "Explore data and run code interactively.",
      icon: NEW_FILETYPE_ICONS.ipynb,
      color: COLORS.COCALC_ORANGE,
      onClick: () => createFile("ipynb"),
    },
    ...(aiAllowed
      ? [
          {
            title: "Chat with AI",
            description: "Plan, explain, and work through ideas.",
            icon: NEW_FILETYPE_ICONS.chat,
            color: COLORS.ANTD_LINK_BLUE,
            onClick: () => createFile("chat"),
          },
        ]
      : []),
    {
      title: "Terminal",
      description: "Use a shell in this project environment.",
      icon: NEW_FILETYPE_ICONS.term,
      color: COLORS.GRAY_D,
      onClick: () => createFile("term"),
    },
    {
      title: "Upload Files",
      description: "Drop files here or choose them from your computer.",
      icon: "cloud-upload",
      color: COLORS.BS_GREEN_D,
      className: "upload-button",
    },
    {
      title: "LaTeX Document",
      description: "Write and compile math-rich documents.",
      icon: NEW_FILETYPE_ICONS.tex,
      color: COLORS.BLUE_D,
      onClick: () => createFile("tex"),
    },
    {
      title: "Markdown Notes",
      description: "Start a lightweight document or README.",
      icon: NEW_FILETYPE_ICONS.md,
      color: COLORS.ANTD_LINK_BLUE_DARK,
      onClick: () => createFile("md"),
    },
  ];

  return (
    <div
      style={{
        margin: "18px 24px 0 24px",
        border: `1px solid ${COLORS.GRAY_DDD}`,
        borderRadius: 18,
        overflow: "hidden",
        background: `linear-gradient(135deg, ${COLORS.BLUE_LLLL} 0%, ${COLORS.GRAY_LLL} 55%, ${COLORS.BS_GREEN_LL} 100%)`,
        boxShadow: `0 16px 40px ${COLORS.GRAY_DDD}`,
      }}
    >
      <div
        style={{
          padding: "28px 28px 8px 28px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderRadius: 999,
            background: "white",
            color: COLORS.BLUE_DD,
            fontWeight: 600,
            boxShadow: `0 4px 18px ${COLORS.GRAY_DDD}`,
          }}
        >
          <Icon name="folder-open" /> Empty project
        </div>
        <h2
          style={{
            margin: "16px 0 6px 0",
            color: COLORS.GRAY_DD,
            fontSize: 28,
            fontWeight: 700,
          }}
        >
          Welcome to your project
        </h2>
        <div
          style={{
            color: COLORS.GRAY_M,
            fontSize: 16,
            maxWidth: 620,
            margin: "0 auto",
          }}
        >
          Create, compute, write, or upload files to get started.
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: 14,
          padding: 22,
        }}
      >
        {actions.map((action) => (
          <button
            key={action.title}
            className={action.className}
            onClick={action.onClick}
            type="button"
            style={{
              textAlign: "left",
              border: `1px solid ${COLORS.GRAY_DDD}`,
              borderRadius: 14,
              padding: 16,
              minHeight: 112,
              background: "white",
              cursor: "pointer",
              boxShadow: `0 8px 24px ${COLORS.GRAY_DDD}`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 10,
              }}
            >
              <span
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 12,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: action.color,
                  color: "white",
                  fontSize: 18,
                }}
              >
                <Icon name={action.icon} />
              </span>
              <strong style={{ color: COLORS.GRAY_DD, fontSize: 15 }}>
                {action.title}
              </strong>
            </div>
            <div style={{ color: COLORS.GRAY_M, lineHeight: 1.35 }}>
              {action.description}
            </div>
          </button>
        ))}
      </div>

      <div
        style={{
          borderTop: `1px solid ${COLORS.GRAY_DDD}`,
          background: "white",
          padding: "14px 22px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <span style={{ color: COLORS.GRAY_M }}>
          Prefer the full launcher with more file types?
        </span>
        <Button type="primary" onClick={openNewPage}>
          Browse file types
        </Button>
      </div>
    </div>
  );
}
