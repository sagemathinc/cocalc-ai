/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { dirname, join } from "path";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { project_redux_name, redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { lazyWithRetry } from "@cocalc/frontend/app/lazy-with-retry";
import { Loading } from "@cocalc/frontend/components/loading";
import { set_url } from "@cocalc/frontend/history";
import { afterNextPaint } from "@cocalc/frontend/monitoring/ux-latency-trace";
import useFiles, {
  type FileData,
} from "@cocalc/frontend/project/listing/use-files";
import {
  recordDirectoryListingPaint,
  startDirectoryNavigationTrace,
} from "@cocalc/frontend/project/listing/ux-latency";
import {
  getReducedProjectState,
  setReducedProjectPath,
  subscribeReducedProjectState,
} from "@cocalc/frontend/project/reduced-runtime";
import { toUrlPath } from "@cocalc/frontend/project/redux/path-routing";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { getProjectUrlPath } from "@cocalc/frontend/project-routing";
import { COLORS } from "@cocalc/util/theme";

interface Props {
  is_active: boolean;
  project_id: string;
}

const FullProjectPage = lazyWithRetry<Props>(
  async () => ({ default: (await import("./page")).ProjectPage }),
  "full project workspace",
);

const MAX_RENDERED_ENTRIES = 200;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const amount = bytes / 1024 ** unit;
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function EntryRow({
  data,
  name,
  onOpen,
}: {
  data: FileData;
  name: string;
  onOpen: () => void;
}) {
  const modified = data.mtime
    ? new Date(data.mtime).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
  return (
    <button
      aria-label={`${data.isDir ? "Open folder" : "Open file"} ${name}`}
      onClick={onOpen}
      style={{
        alignItems: "center",
        background: "transparent",
        border: 0,
        borderBottom: `1px solid ${COLORS.GRAY_LL}`,
        color: COLORS.GRAY_DD,
        cursor: "pointer",
        display: "grid",
        font: "inherit",
        gap: "12px",
        gridTemplateColumns: "minmax(0, 1fr) minmax(110px, 170px) 80px",
        minHeight: "42px",
        padding: "7px 12px",
        textAlign: "left",
        width: "100%",
      }}
      type="button"
    >
      <span
        style={{
          color: data.isDir ? COLORS.BLUE_DD : COLORS.GRAY_D,
          fontWeight: data.isDir ? 650 : 450,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <span aria-hidden="true" style={{ display: "inline-block", width: 24 }}>
          {data.isDir ? ">" : "-"}
        </span>
        {name}
      </span>
      <span style={{ color: COLORS.GRAY_M, fontSize: "12px" }}>{modified}</span>
      <span
        style={{ color: COLORS.GRAY_M, fontSize: "12px", textAlign: "right" }}
      >
        {data.isDir ? "Folder" : formatBytes(data.size)}
      </span>
    </button>
  );
}

function FullProjectBootstrap(props: Props) {
  const [ready, setReady] = useState(
    () => redux.getStore(project_redux_name(props.project_id)) != null,
  );
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (ready) return;
    let mounted = true;
    void ensureProjectReduxRuntime()
      .then(() => {
        redux.getProjectStore(props.project_id);
        if (mounted) setReady(true);
      })
      .catch((err) => {
        if (mounted) setError(`${err}`);
      });
    return () => {
      mounted = false;
    };
  }, [props.project_id, ready]);
  if (error != null) {
    return <div role="alert">Unable to load the full workspace: {error}</div>;
  }
  if (!ready) return <Loading theme="medium" />;
  return <FullProjectPage {...props} />;
}

export const ProjectPage: React.FC<Props> = ({ is_active, project_id }) => {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeReducedProjectState(project_id, listener),
    [project_id],
  );
  const getSnapshot = useCallback(
    () => getReducedProjectState(project_id),
    [project_id],
  );
  const reducedProject = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const [filesystemRevision, setFilesystemRevision] = useState(0);
  const [fullWorkspaceError, setFullWorkspaceError] = useState<string>();
  const [fullWorkspaceLoading, setFullWorkspaceLoading] = useState(false);
  const listingCacheId = useMemo(() => ({ project_id }), [project_id]);
  const viewer = reducedProject?.viewer === true;
  const filesystem = useMemo(() => {
    if (reducedProject == null) return;
    const client = webapp_client.conat_client.projectFs({
      caller: "ReducedProjectPage",
      project_id,
      viewer: viewer || undefined,
    });
    return {
      getListing: async (path: string) => (await client).getListing(path),
      listing: async (path: string) => (await client).listing(path),
    };
  }, [filesystemRevision, project_id, reducedProject == null, viewer]);
  const refreshFilesystem = useCallback(() => {
    setFilesystemRevision((revision) => revision + 1);
  }, []);
  const currentPath = reducedProject?.path ?? "/home/user";
  const { error, files, refresh, telemetry } = useFiles({
    cacheId: listingCacheId,
    fs: filesystem,
    path: currentPath,
    refreshFs: refreshFilesystem,
    watch: is_active && !viewer,
    uxContext:
      reducedProject == null || !is_active
        ? undefined
        : {
            project_id,
            host_id: reducedProject.hostId,
            surface_visible: true,
          },
  });

  const entries = useMemo(
    () =>
      Object.entries(files ?? {}).sort(([nameA, a], [nameB, b]) => {
        if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
        return nameA.localeCompare(nameB, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      }),
    [files],
  );

  useEffect(() => {
    if (
      reducedProject == null ||
      !is_active ||
      files == null ||
      telemetry == null
    ) {
      return;
    }
    return afterNextPaint(() => {
      recordDirectoryListingPaint({
        project_id,
        path: currentPath,
        telemetry,
        rendered_entries: Math.min(entries.length, MAX_RENDERED_ENTRIES),
        surface_visible: true,
      });
    });
  }, [
    currentPath,
    entries.length,
    files,
    is_active,
    project_id,
    reducedProject,
    telemetry,
  ]);

  if (reducedProject == null) {
    return (
      <FullProjectBootstrap is_active={is_active} project_id={project_id} />
    );
  }

  const directoryTarget = (path: string) =>
    toUrlPath({
      homeDirectory: reducedProject.homeDirectory,
      isDirectory: true,
      path,
    });
  const openDirectory = (path: string) => {
    startDirectoryNavigationTrace({
      host_id: reducedProject.hostId,
      path,
      project_id,
      surface_visible: true,
    });
    setReducedProjectPath(project_id, path);
    set_url(getProjectUrlPath(project_id, directoryTarget(path)));
  };
  const loadFullWorkspace = async (target: string) => {
    setFullWorkspaceError(undefined);
    setFullWorkspaceLoading(true);
    try {
      await redux.getActions("projects").open_project({
        change_history: true,
        force_full_workspace: true,
        project_id,
        restore_session: false,
        switch_to: true,
        target,
      });
    } catch (err) {
      setFullWorkspaceError(`${err}`);
      setFullWorkspaceLoading(false);
    }
  };
  const openEntry = (name: string, data: FileData) => {
    const path = join(currentPath, name);
    if (data.isDir) {
      openDirectory(path);
      return;
    }
    void loadFullWorkspace(
      toUrlPath({
        homeDirectory: reducedProject.homeDirectory,
        isDirectory: false,
        path,
      }),
    );
  };
  const parent = dirname(currentPath);
  const visibleEntries = entries.slice(0, MAX_RENDERED_ENTRIES);

  return (
    <main
      aria-label="Fast project file browser"
      style={{
        background: `linear-gradient(135deg, ${COLORS.BLUE_LLLL}, ${COLORS.TOP_BAR.ACTIVE} 36%, ${COLORS.GRAY_LLL})`,
        color: COLORS.GRAY_DD,
        display: "flex",
        flex: 1,
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          alignItems: "center",
          borderBottom: `1px solid ${COLORS.GRAY_L0}`,
          display: "flex",
          flexWrap: "wrap",
          gap: "10px",
          padding: "10px 14px",
        }}
      >
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <div
            style={{ fontSize: "12px", fontWeight: 700, letterSpacing: 0.6 }}
          >
            FAST LOADING MODE
          </div>
          <div
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: "14px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={currentPath}
          >
            {reducedProject.title} / {currentPath}
          </div>
        </div>
        {parent !== currentPath ? (
          <button
            aria-label="Open parent folder"
            disabled={fullWorkspaceLoading}
            onClick={() => openDirectory(parent)}
            style={secondaryButtonStyle}
            type="button"
          >
            Parent folder
          </button>
        ) : null}
        <button
          disabled={fullWorkspaceLoading}
          onClick={() => void loadFullWorkspace(directoryTarget(currentPath))}
          style={primaryButtonStyle}
          type="button"
        >
          {fullWorkspaceLoading
            ? "Loading workspace..."
            : "Load full workspace"}
        </button>
      </header>
      {fullWorkspaceError != null ? (
        <div role="alert" style={{ padding: "10px 14px" }}>
          Unable to load the full workspace: {fullWorkspaceError}
        </div>
      ) : null}
      <div
        aria-busy={files == null && error == null}
        style={{
          background: COLORS.TOP_BAR.ACTIVE,
          flex: 1,
          margin: "10px",
          minHeight: 0,
          overflow: "auto",
        }}
      >
        {error != null ? (
          <div role="alert" style={{ padding: "24px", textAlign: "center" }}>
            <strong>Unable to load this folder.</strong>
            <div style={{ color: COLORS.GRAY_M, margin: "8px 0 14px" }}>
              {error.message}
            </div>
            <button onClick={refresh} style={primaryButtonStyle} type="button">
              Try again
            </button>
          </div>
        ) : files == null ? (
          <div
            aria-live="polite"
            role="status"
            style={{ padding: "32px", textAlign: "center" }}
          >
            Loading files...
          </div>
        ) : visibleEntries.length === 0 ? (
          <div role="status" style={{ padding: "32px", textAlign: "center" }}>
            This folder is empty.
          </div>
        ) : (
          visibleEntries.map(([name, data]) => (
            <EntryRow
              data={data}
              key={name}
              name={name}
              onOpen={() => openEntry(name, data)}
            />
          ))
        )}
        {entries.length > MAX_RENDERED_ENTRIES ? (
          <div
            role="status"
            style={{
              background: COLORS.GRAY_LLL,
              borderTop: `1px solid ${COLORS.GRAY_L0}`,
              padding: "12px",
              textAlign: "center",
            }}
          >
            Showing the first {MAX_RENDERED_ENTRIES.toLocaleString()} of{" "}
            {entries.length.toLocaleString()} entries. Load the full workspace
            to see all entries.
          </div>
        ) : null}
      </div>
    </main>
  );
};

const primaryButtonStyle: React.CSSProperties = {
  background: COLORS.BLUE_DD,
  border: `1px solid ${COLORS.BLUE_DD}`,
  borderRadius: "5px",
  color: COLORS.TOP_BAR.ACTIVE,
  cursor: "pointer",
  font: "inherit",
  fontWeight: 650,
  minHeight: "34px",
  padding: "6px 12px",
};

const secondaryButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  background: COLORS.TOP_BAR.ACTIVE,
  color: COLORS.BLUE_DD,
};
