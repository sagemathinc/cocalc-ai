/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import BackupOps from "./backup-ops";
import CopyOps from "./copy-ops";
import MoveOps from "./move-ops";
import RestoreOps from "./restore-ops";

export default function FileOperationLros({
  project_id,
  canWriteProjectFiles,
  readOnlyViewer,
}: {
  project_id: string;
  canWriteProjectFiles: boolean;
  readOnlyViewer: boolean;
}) {
  return (
    <>
      {canWriteProjectFiles && (
        <>
          <BackupOps project_id={project_id} />
          <RestoreOps project_id={project_id} />
          <MoveOps project_id={project_id} />
        </>
      )}
      {(canWriteProjectFiles || readOnlyViewer) && (
        <CopyOps project_id={project_id} />
      )}
    </>
  );
}
