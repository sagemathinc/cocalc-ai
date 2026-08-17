/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { FilesystemClient } from "@cocalc/conat/files/fs";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import { useEffect, useState } from "react";
import { normalizeProjectPath, navigate } from "./routes";
import type { UltraliteSession } from "./session";
import {
  markUltraliteBackend,
  recordUltraliteFailure,
  recordUltraliteSurfaceReady,
} from "./telemetry";
import { EmptyState, InlineAlert, LoadingState, SurfaceHeader } from "./ui";
import { UltraliteIcon } from "./icons";

const HOME = "/home/user";
const MAX_NOTEBOOKS = 200;
const FIND_FORMAT = "%T@\t%P\n";
const notebookCache = new Map<string, RecentNotebook[]>();

export interface RecentNotebook {
  modified: number;
  path: string;
  relativePath: string;
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function visibleNotebookPath(relativePath: string): boolean {
  return !relativePath.split("/").some((part) => !part || part.startsWith("."));
}

export function parseRecentNotebooks(output: string): RecentNotebook[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\t");
      if (separator < 0) return;
      const modifiedSeconds = Number(line.slice(0, separator));
      const relativePath = line.slice(separator + 1).replace(/^\.\//, "");
      if (
        !Number.isFinite(modifiedSeconds) ||
        !relativePath.toLowerCase().endsWith(".ipynb") ||
        !visibleNotebookPath(relativePath)
      ) {
        return;
      }
      const path = normalizeProjectPath(`${HOME}/${relativePath}`);
      if (path === HOME) return;
      return {
        modified: modifiedSeconds * 1000,
        path,
        relativePath,
      };
    })
    .filter((entry): entry is RecentNotebook => entry != null)
    .sort((a, b) => b.modified - a.modified)
    .slice(0, MAX_NOTEBOOKS);
}

async function findNotebooks(
  filesystem: FilesystemClient,
): Promise<RecentNotebook[]> {
  const result = await filesystem.find(HOME, {
    options: [
      "(",
      "-path",
      "*/.*",
      "-prune",
      ")",
      "-o",
      "-type",
      "f",
      "-name",
      "*.ipynb",
    ],
    linux: ["-printf", FIND_FORMAT],
    maxSize: 512 * 1024,
    timeout: 20_000,
  });
  const stderr = text(result.stderr);
  if (result.code !== 0 && stderr.trim()) throw new Error(stderr.trim());
  return parseRecentNotebooks(text(result.stdout));
}

export default function NotebooksSurface({
  project,
  session,
}: {
  project: AccountProjectListWindowRow;
  session: UltraliteSession;
}) {
  const [notebooks, setNotebooks] = useState<RecentNotebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!project.host_id) return;
    let cancelled = false;
    const cacheKey = `${project.host_id}:${project.project_id}`;
    const cached = reload === 0 ? notebookCache.get(cacheKey) : undefined;
    if (cached) {
      setNotebooks(cached);
      setError(undefined);
      setLoading(false);
      recordUltraliteSurfaceReady("notebooks");
      return;
    }
    setLoading(true);
    setError(undefined);
    markUltraliteBackend("notebooks", "start");
    void session
      .openProjectFiles(project.project_id, project.host_id)
      .then(({ filesystem }) => findNotebooks(filesystem))
      .then((records) => {
        if (cancelled) return;
        notebookCache.set(cacheKey, records);
        setNotebooks(records);
        recordUltraliteSurfaceReady("notebooks");
      })
      .catch((err) => {
        if (cancelled) return;
        recordUltraliteFailure("notebooks", err);
        setError(err instanceof Error ? err.message : `${err}`);
      })
      .finally(() => {
        if (cancelled) return;
        markUltraliteBackend("notebooks", "end");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.host_id, project.project_id, reload, session]);

  return (
    <main className="ul-page" id="main-content">
      <SurfaceHeader
        actions={
          <button
            className="ul-icon-button"
            disabled={loading}
            onClick={() => setReload((value) => value + 1)}
            type="button"
          >
            <UltraliteIcon name="refresh" /> Refresh notebook list
          </button>
        }
        eyebrow="Recent project notebooks"
        title="Jupyter"
      />
      <p className="ul-muted">
        The project host scans for notebooks without starting project compute.
        The 200 most recently modified notebooks are cached for this browser
        session until you refresh the list.
      </p>
      {loading ? <LoadingState label="Finding notebooks" /> : null}
      {error ? <InlineAlert kind="error">{error}</InlineAlert> : null}
      {!loading && !error && notebooks.length ? (
        <div className="ul-compact-list">
          {notebooks.map((notebook) => (
            <button
              aria-label={`Open notebook ${notebook.relativePath}`}
              className="ul-compact-row"
              key={notebook.path}
              onClick={() =>
                navigate({
                  kind: "file",
                  path: notebook.path,
                  projectId: project.project_id,
                })
              }
              type="button"
            >
              <div className="ul-row-title">
                {notebook.relativePath.split("/").pop()}
              </div>
              <div className="ul-row-detail">{notebook.relativePath}</div>
              <div className="ul-row-detail">
                Modified {new Date(notebook.modified).toLocaleString()}
              </div>
            </button>
          ))}
        </div>
      ) : null}
      {!loading && !error && !notebooks.length ? (
        <EmptyState>No notebooks were found in this project.</EmptyState>
      ) : null}
    </main>
  );
}
