/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert } from "antd";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import NewFilePage from "@cocalc/frontend/project/new/new-file-page";

interface Props {
  file_search: string;
  current_path: string;
  project_id: string;
}

function shouldShowCreatePage({
  current_path,
  file_search,
  homePath,
}: {
  current_path: string;
  file_search: string;
  homePath: string;
}): boolean {
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
  const homePath = getProjectHomeDirectory(project_id);
  if (
    !shouldShowCreatePage({
      current_path,
      file_search,
      homePath,
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
