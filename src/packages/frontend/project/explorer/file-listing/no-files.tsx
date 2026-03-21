/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import type { ProjectActions } from "@cocalc/frontend/project_actions";

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
    | Pick<ProjectActions, "setState" | "set_file_search" | "set_active_tab">
    | undefined;
  let type_filter: string | null = null;
  try {
    actions = redux.getProjectActions(project_id);
    type_filter = redux.getProjectStore(project_id)?.get("type_filter") ?? null;
  } catch {
    // Allow isolated rendering in tests that use a placeholder project id.
  }

  function openNewPage() {
    actions?.set_active_tab("new");
    actions?.setState({
      new_page_path_abs: current_path,
      ...(file_search.trim()
        ? { default_filename: file_search.trim() }
        : undefined),
    } as any);
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
  return (
    <Alert
      type="warning"
      showIcon
      style={{ margin: "8px 16px 0 16px" }}
      title="No files or folders to display."
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
