/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import NewFilePage from "@cocalc/frontend/project/new/new-file-page";

interface Props {
  file_search: string;
  project_id: string;
}

export default function NoFiles({
  file_search = "",
  project_id,
}: Props) {
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
