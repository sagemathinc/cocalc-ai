/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import { useState } from "react";
import { UltraliteIcon } from "./icons";
import { navigate } from "./routes";
import { clearRecentFiles, readRecentFiles } from "./recent-files";
import { EmptyState, SurfaceHeader } from "./ui";

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "/home/user";
}

export default function RecentSurface({
  accountId,
  project,
}: {
  accountId: string;
  project: AccountProjectListWindowRow;
}) {
  const [revision, setRevision] = useState(0);
  const files = readRecentFiles(accountId).filter(
    ({ projectId }) => projectId === project.project_id,
  );
  return (
    <main className="ul-page" id="main-content">
      <SurfaceHeader
        actions={
          files.length ? (
            <button
              className="ul-button ul-button-secondary"
              onClick={() => {
                clearRecentFiles(accountId, project.project_id);
                setRevision((value) => value + 1);
              }}
              type="button"
            >
              Clear
            </button>
          ) : undefined
        }
        eyebrow="Stored in this browser"
        title="Recent files"
      />
      {files.length ? (
        <div className="ul-compact-list" key={revision}>
          {files.map((file) => (
            <button
              className="ul-compact-row ul-row-grid"
              key={`${file.projectId}:${file.path}`}
              onClick={() =>
                navigate({
                  kind: "file",
                  path: file.path,
                  projectId: file.projectId,
                })
              }
              type="button"
            >
              <span className="ul-recent-file">
                <span className="ul-row-title">
                  <UltraliteIcon name="file" size={15} />
                  {file.path.split("/").pop()}
                </span>
                <span className="ul-row-detail">{parentPath(file.path)}</span>
              </span>
              <span className="ul-row-detail">
                {new Date(file.openedAt).toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState>
          Files you open in this project will appear here on this browser.
        </EmptyState>
      )}
    </main>
  );
}
