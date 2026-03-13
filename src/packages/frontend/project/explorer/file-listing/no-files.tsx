/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import NewFilePage from "@cocalc/frontend/project/new/new-file-page";
import type { ProjectActions } from "@cocalc/frontend/project_actions";

interface Props {
  file_search: string;
  current_path: string;
  project_id: string;
}

function shouldShowCreatePage({
  current_path,
  file_search,
  homePath,
  type_filter,
}: {
  current_path: string;
  file_search: string;
  homePath: string;
  type_filter?: string | null;
}): boolean {
  if (type_filter) return false;
  if (file_search.trim()) return true;
  if (!current_path.startsWith("/")) return true;
  if (homePath === "/") return true;
  return current_path === homePath || current_path.startsWith(`${homePath}/`);
}

export default function NoFiles({
  file_search = "",
  current_path,
  project_id,
}: Props) {
  let actions: Pick<ProjectActions, "setState" | "set_file_search"> | undefined;
  let type_filter: string | null = null;
  try {
    actions = redux.getProjectActions(project_id);
    type_filter = redux.getProjectStore(project_id)?.get("type_filter") ?? null;
  } catch {
    // Allow isolated rendering in tests that use a placeholder project id.
  }
  const homePath = getProjectHomeDirectory(project_id);
  if (type_filter) {
    return (
      <Alert
        type="info"
        showIcon
        style={{ margin: "8px 16px 0 16px" }}
        message="No files or folders match the current filter."
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
          </Space>
        }
      />
    );
  }
  if (
    !shouldShowCreatePage({
      current_path,
      file_search,
      homePath,
      type_filter,
    })
  ) {
    return (
      <Alert
        type="info"
        showIcon
        style={{ margin: "8px 16px 0 16px" }}
        message="No files or folders to display."
      />
    );
  }
  return (
    <div
      style={{
        wordWrap: "break-word",
        overflowY: "auto",
        padding: "8px 16px 0 16px",
      }}
      className="smc-vfill"
    >
      <NewFilePage
        project_id={project_id}
        initialFilename={file_search}
        autoFocusFilename={false}
      />
    </div>
  );
}
