/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert } from "antd";
import { FormattedMessage } from "react-intl";

// Shown instead of a file listing for an archived project. Users who can run
// the project get a Start link; viewers are told who can restore it, so the
// listing's expected 403 is never presented as a "wrong account" problem.
export function ArchivedProjectNotice({
  projectLabelLower,
  archiveReasonText,
  canStart,
  onStart,
}: {
  projectLabelLower: string;
  archiveReasonText?: string;
  canStart: boolean;
  onStart: () => void;
}) {
  return (
    <Alert
      type="info"
      showIcon
      style={{ margin: "16px auto", maxWidth: "760px" }}
      title={`This ${projectLabelLower} is archived.`}
      description={
        <>
          {archiveReasonText && (
            <div style={{ marginBottom: "4px" }}>
              <strong>{archiveReasonText}</strong>
            </div>
          )}
          {canStart ? (
            <FormattedMessage
              id="project.explorer.archived_project.warning"
              defaultMessage={
                "Archived projects do not count toward active storage. <a>Start this project</a> to restore it from backup and make the filesystem available again. Once restored, it will count toward your global storage quota."
              }
              values={{
                a: (chunks) => (
                  <a
                    onClick={(e) => {
                      e.preventDefault();
                      onStart();
                    }}
                  >
                    {chunks}
                  </a>
                ),
              }}
            />
          ) : (
            <FormattedMessage
              id="project.explorer.archived_project.viewer_warning"
              defaultMessage={
                "Its files are stored in a backup and are not available until an owner or collaborator starts the project."
              }
            />
          )}
        </>
      }
    />
  );
}
