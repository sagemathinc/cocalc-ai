/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import type { Files } from "@cocalc/conat/files/listing";
import type { FilesystemClient } from "@cocalc/conat/files/fs";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ExternalMergeHandle } from "./external-merge";
import NotebookView, {
  parseNotebook,
  type NotebookDocument,
} from "./notebook-view";
import { navigate, normalizeProjectPath, type UltraliteRoute } from "./routes";
import type { UltraliteSession } from "./session";
import { fullProjectUrl } from "./urls";
import {
  ChunkErrorBoundary,
  EmptyState,
  InlineAlert,
  LoadingState,
  SurfaceHeader,
} from "./ui";
import { UltraliteIcon } from "./icons";
import { startOpenFileWatch } from "./open-file-watch";
import {
  markUltraliteBackend,
  recordUltraliteFailure,
  recordUltraliteOutcome,
  recordUltraliteSurfaceReady,
} from "./telemetry";

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_NOTEBOOK_BYTES = 15 * 1024 * 1024;
const MAX_NOTEBOOK_EDIT_BYTES = 5 * 1024 * 1024;

type CreateKind = "file" | "folder";

const CodeView = lazy(
  () =>
    new Promise((resolve, reject) => {
      require.ensure(
        [],
        () => resolve(require("./code-view")),
        reject,
        "ultralite-code",
      );
    }),
);
const NotebookEditor = lazy(
  () =>
    new Promise((resolve, reject) => {
      require.ensure(
        [],
        () => resolve(require("./notebook-editor")),
        reject,
        "ultralite-notebook-execute",
      );
    }),
);

function childPath(parent: string, name: string): string {
  return normalizeProjectPath(`${parent.replace(/\/$/, "")}/${name}`);
}

function parentPath(path: string): string {
  const parts = normalizeProjectPath(path).split("/").filter(Boolean);
  if (parts.length <= 2) return "/home/user";
  parts.pop();
  return `/${parts.join("/")}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** unit;
  return `${unit === 0 || value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function asText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

export function validateNewEntryName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Enter a name.");
  if (name === "." || name === "..") {
    throw new Error("A file or folder cannot be named . or ...");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("Enter one name without slashes.");
  }
  const utf8Bytes = Array.from(name).reduce((total, character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      total +
      (codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4)
    );
  }, 0);
  if (utf8Bytes > 255) {
    throw new Error("This name exceeds the filesystem's 255-byte limit.");
  }
  return name;
}

export function ExternalChangeActions({
  merging,
  onMerge,
  onReload,
}: {
  merging: boolean;
  onMerge: () => void;
  onReload: () => void;
}) {
  return (
    <InlineAlert kind="warning">
      <div>
        This file changed on disk while it was open. Your current draft has been
        retained, and saving is blocked until you reconcile it.
      </div>
      <div className="ul-toolbar">
        <button
          className="ul-button"
          disabled={merging}
          onClick={onMerge}
          type="button"
        >
          {merging ? "Merging..." : "Merge disk changes"}
        </button>
        <button
          className="ul-button ul-button-secondary"
          disabled={merging}
          onClick={onReload}
          type="button"
        >
          Discard draft and reload
        </button>
      </div>
    </InlineAlert>
  );
}

function initialFileContents(name: string): string {
  return name.toLowerCase().endsWith(".ipynb")
    ? `${JSON.stringify(
        {
          cells: [],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        },
        null,
        1,
      )}\n`
    : "";
}

function Breadcrumbs({ projectId, path }: { projectId: string; path: string }) {
  const relative = path.replace(/^\/home\/user\/?/, "");
  const names = relative ? relative.split("/") : [];
  return (
    <nav aria-label="File path" className="ul-breadcrumbs">
      <button
        onClick={() =>
          navigate({ kind: "files", projectId, path: "/home/user" })
        }
        type="button"
      >
        <UltraliteIcon name="folder" size={15} /> Home
      </button>
      {names.map((name, index) => {
        const current = `/home/user/${names.slice(0, index + 1).join("/")}`;
        return (
          <span key={current}>
            <span aria-hidden="true">/</span>
            <button
              onClick={() =>
                navigate({ kind: "files", projectId, path: current })
              }
              type="button"
            >
              {name}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function DirectoryView({
  project,
  path,
  files,
  truncated,
}: {
  project: AccountProjectListWindowRow;
  path: string;
  files: Files;
  truncated?: boolean;
}) {
  const entries = Object.entries(files).sort(([nameA, a], [nameB, b]) => {
    const aDirectory = a.type === "d" || a.isDir;
    const bDirectory = b.type === "d" || b.isDir;
    if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;
    return nameA.localeCompare(nameB, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
  return (
    <>
      {truncated ? (
        <InlineAlert kind="warning">
          This directory is large. The project host returned a truncated
          listing.
        </InlineAlert>
      ) : null}
      <div className="ul-file-list">
        <div aria-hidden="true" className="ul-file-row ul-file-header">
          <span className="ul-file-name">Name</span>
          <span className="ul-file-meta ul-file-modified">Modified</span>
          <span className="ul-file-meta">Size</span>
        </div>
        {path !== "/home/user" ? (
          <button
            className="ul-file-row"
            onClick={() =>
              navigate({
                kind: "files",
                projectId: project.project_id,
                path: parentPath(path),
              })
            }
            type="button"
          >
            <span className="ul-file-name ul-file-directory">
              <UltraliteIcon name="back" size={16} /> Parent directory
            </span>
            <span className="ul-file-meta ul-file-modified" />
            <span className="ul-file-meta">Folder</span>
          </button>
        ) : null}
        {entries.map(([name, data]) => {
          const directory = data.type === "d" || data.isDir;
          const target = childPath(path, name);
          return (
            <button
              aria-label={`${directory ? "Open folder" : "Open file"} ${name}`}
              className="ul-file-row"
              key={name}
              onClick={() =>
                navigate({
                  kind: directory ? "files" : "file",
                  projectId: project.project_id,
                  path: target,
                })
              }
              type="button"
            >
              <span
                className={`ul-file-name ${directory ? "ul-file-directory" : ""}`}
              >
                <UltraliteIcon name={directory ? "folder" : "file"} size={16} />
                {name}
              </span>
              <span className="ul-file-meta ul-file-modified">
                {data.mtime ? new Date(data.mtime).toLocaleDateString() : ""}
              </span>
              <span className="ul-file-meta">
                {directory ? "Folder" : formatBytes(data.size)}
              </span>
            </button>
          );
        })}
        {!entries.length ? (
          <EmptyState>This directory is empty.</EmptyState>
        ) : null}
      </div>
    </>
  );
}

export default function FileSurface({
  project,
  route,
  session,
}: {
  project: AccountProjectListWindowRow;
  route: Extract<UltraliteRoute, { kind: "files" | "file" }>;
  session: UltraliteSession;
}) {
  const [filesystem, setFilesystem] = useState<FilesystemClient>();
  const [files, setFiles] = useState<Files>();
  const [truncated, setTruncated] = useState(false);
  const [contents, setContents] = useState<string>();
  const [notebook, setNotebook] = useState<NotebookDocument>();
  const [notebookContents, setNotebookContents] = useState<string>();
  const [notebookEditable, setNotebookEditable] = useState(false);
  const [executeNotebook, setExecuteNotebook] = useState(false);
  const [editable, setEditable] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [codeEditing, setCodeEditing] = useState(false);
  const [externalChanged, setExternalChanged] = useState(false);
  const [mergingExternal, setMergingExternal] = useState(false);
  const [externalMergeError, setExternalMergeError] = useState<string>();
  const [watchError, setWatchError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [createKind, setCreateKind] = useState<CreateKind>();
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const dirtyRef = useRef(dirty);
  const editorActiveRef = useRef(codeEditing || executeNotebook);
  const localSaveUntilRef = useRef(0);
  const codeViewRef = useRef<ExternalMergeHandle>(null);
  const notebookEditorRef = useRef<ExternalMergeHandle>(null);
  dirtyRef.current = dirty;
  editorActiveRef.current = codeEditing || executeNotebook;

  useEffect(() => {
    setExecuteNotebook(false);
    setCodeEditing(false);
    setDirty(false);
    setExternalChanged(false);
    setExternalMergeError(undefined);
    setWatchError(false);
    setCreateKind(undefined);
    setCreateName("");
    setCreateError(undefined);
  }, [route.kind, route.path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void session
      .openProjectFiles(project.project_id, project.host_id!)
      .then(({ filesystem }) => {
        if (!cancelled) setFilesystem(filesystem);
      })
      .catch((err) => {
        if (!cancelled) {
          recordUltraliteFailure(
            route.kind === "files" ? "files" : "file",
            err,
          );
          setError(err instanceof Error ? err.message : `${err}`);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project.host_id, project.project_id, session]);

  useEffect(() => {
    if (!filesystem) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setFiles(undefined);
    setContents(undefined);
    setNotebook(undefined);
    setNotebookContents(undefined);
    setNotebookEditable(false);
    setEditable(false);
    setDirty(false);
    const surface =
      route.kind === "files"
        ? "files"
        : route.path.toLowerCase().endsWith(".ipynb")
          ? "notebook"
          : "file";
    markUltraliteBackend(surface, "start");
    void (async () => {
      if (route.kind === "files") {
        const listing = await filesystem.getListing(route.path);
        if (!cancelled) {
          setFiles(listing.files);
          setTruncated(listing.truncated === true);
          markUltraliteBackend(surface, "end");
        }
        return;
      }
      const stats = await filesystem.stat(route.path);
      const notebookFile = route.path.toLowerCase().endsWith(".ipynb");
      const limit = notebookFile ? MAX_NOTEBOOK_BYTES : MAX_TEXT_BYTES;
      if (stats.size > limit) {
        recordUltraliteOutcome(
          notebookFile ? "notebook" : "file",
          "unsupported_file",
        );
        throw new Error(
          `This ${formatBytes(stats.size)} file exceeds the ${formatBytes(limit)} ultralite viewing limit.`,
        );
      }
      const text = asText(
        (await filesystem.readFile(route.path, "utf8")) as string | Uint8Array,
      );
      if (!notebookFile && text.includes("\0")) {
        recordUltraliteOutcome("file", "unsupported_file");
        throw new Error(
          "This appears to be a binary file. Open it in full CoCalc.",
        );
      }
      if (!cancelled) {
        markUltraliteBackend(surface, "end");
        if (notebookFile) {
          setNotebook(parseNotebook(text));
          setNotebookContents(text);
          setNotebookEditable(stats.size <= MAX_NOTEBOOK_EDIT_BYTES);
        } else {
          setContents(text);
          setEditable(stats.size <= MAX_EDIT_BYTES);
        }
      }
    })()
      .catch((err) => {
        if (!cancelled) {
          markUltraliteBackend(surface, "end");
          recordUltraliteFailure(
            route.kind === "files"
              ? "files"
              : route.path.toLowerCase().endsWith(".ipynb")
                ? "notebook"
                : "file",
            err,
          );
          setError(err instanceof Error ? err.message : `${err}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filesystem, refresh, route.kind, route.path]);

  useEffect(() => {
    if (!filesystem || route.kind !== "file") return;
    setExternalChanged(false);
    setWatchError(false);
    return startOpenFileWatch({
      filesystem,
      path: route.path,
      onChange: () => {
        if (Date.now() < localSaveUntilRef.current) return;
        if (dirtyRef.current || editorActiveRef.current) {
          setExternalChanged(true);
        } else {
          setExternalChanged(false);
          setRefresh((value) => value + 1);
        }
      },
      onError: () => setWatchError(true),
    });
  }, [filesystem, route.kind, route.path]);

  useEffect(() => {
    if (loading || error) return;
    if (route.kind === "files" && files) {
      recordUltraliteSurfaceReady("files");
      return;
    }
    if (notebook) {
      recordUltraliteSurfaceReady("notebook");
      recordUltraliteOutcome("notebook", "file_open");
    } else if (contents != null) {
      recordUltraliteSurfaceReady("file");
      recordUltraliteOutcome("file", "file_open");
    }
  }, [contents, error, files, loading, notebook, route.kind]);

  const download = () => {
    const text = contents ?? notebookContents;
    if (text == null || route.kind !== "file") return;
    const blob = new Blob([text], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = route.path.split("/").pop() || "download";
    link.click();
    URL.revokeObjectURL(url);
  };

  const refreshFile = () => {
    if (dirty && !window.confirm("Discard unsaved changes and reload?")) return;
    setDirty(false);
    setExternalChanged(false);
    setExternalMergeError(undefined);
    setRefresh((value) => value + 1);
  };

  const mergeDiskChanges = async () => {
    if (!filesystem || route.kind !== "file" || mergingExternal) return;
    const editor = executeNotebook
      ? notebookEditorRef.current
      : codeViewRef.current;
    if (!editor) {
      setExternalMergeError("The editor is still loading. Try again shortly.");
      return;
    }
    setMergingExternal(true);
    setExternalMergeError(undefined);
    try {
      const notebookFile = route.path.toLowerCase().endsWith(".ipynb");
      const limit = notebookFile ? MAX_NOTEBOOK_EDIT_BYTES : MAX_EDIT_BYTES;
      const stats = await filesystem.stat(route.path);
      if (stats.size > limit) {
        throw new Error(
          `The newer ${formatBytes(stats.size)} file exceeds the ${formatBytes(limit)} Essential editing limit. Open Full CoCalc to reconcile it.`,
        );
      }
      const latest = asText(
        (await filesystem.readFile(route.path, "utf8")) as string | Uint8Array,
      );
      if (!notebookFile && latest.includes("\0")) {
        throw new Error(
          "The newer version appears to be binary. Open Full CoCalc to reconcile it.",
        );
      }
      const result = editor.mergeExternal(latest);
      if (!result.clean) {
        setExternalMergeError(result.message);
        return;
      }
      setDirty(result.dirty);
      setExternalChanged(false);
    } catch (err) {
      setExternalMergeError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setMergingExternal(false);
    }
  };

  const markLocalSave = () => {
    // The project-host watcher may deliver the corresponding write just after
    // the save RPC resolves. Do not misclassify that local write as a conflict.
    localSaveUntilRef.current = Date.now() + 1_500;
    setExternalChanged(false);
  };

  const group = project.users_summary?.[session.accountId]?.group;
  const canWrite = group === "owner" || group === "collaborator";

  const createEntry = async () => {
    if (!filesystem || route.kind !== "files" || !createKind || creating) {
      return;
    }
    setCreating(true);
    setCreateError(undefined);
    try {
      const name = validateNewEntryName(createName);
      const target = childPath(route.path, name);
      if (await filesystem.exists(target)) {
        throw new Error(`'${name}' already exists.`);
      }
      if (createKind === "folder") {
        await filesystem.mkdir(target);
      } else {
        await filesystem.writeFile(target, initialFileContents(name), true);
      }
      recordUltraliteOutcome("files", `create_${createKind}`);
      navigate({
        kind: createKind === "folder" ? "files" : "file",
        projectId: project.project_id,
        path: target,
      });
    } catch (err) {
      recordUltraliteFailure("files", err);
      setCreateError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="ul-page" id="main-content">
      <SurfaceHeader
        actions={
          <>
            <button
              className="ul-icon-button"
              onClick={refreshFile}
              type="button"
            >
              <UltraliteIcon name="refresh" />
              {route.kind === "files" ? "Reload listing" : "Reload from disk"}
            </button>
            {route.kind === "file" && (contents != null || notebook) ? (
              <button
                className="ul-icon-button"
                onClick={download}
                type="button"
              >
                Download
              </button>
            ) : null}
            <a
              className="ul-link-button ul-link-button-subtle"
              data-ul-full-cocalc
              href={fullProjectUrl({
                projectId: project.project_id,
                path: route.path,
              })}
            >
              Full CoCalc
            </a>
          </>
        }
        eyebrow={route.kind === "files" ? "Project files" : "File"}
        title={
          route.kind === "files"
            ? route.path === "/home/user"
              ? "Home"
              : route.path.split("/").pop() || "Files"
            : route.path.split("/").pop() || "File"
        }
      />
      <Breadcrumbs
        projectId={project.project_id}
        path={route.kind === "file" ? parentPath(route.path) : route.path}
      />
      {loading ? <LoadingState label="Loading from the project host" /> : null}
      {error ? <InlineAlert kind="error">{error}</InlineAlert> : null}
      {externalChanged ? (
        <ExternalChangeActions
          merging={mergingExternal}
          onMerge={() => void mergeDiskChanges()}
          onReload={refreshFile}
        />
      ) : null}
      {externalMergeError ? (
        <InlineAlert kind="error">{externalMergeError}</InlineAlert>
      ) : null}
      {watchError && route.kind === "file" ? (
        <InlineAlert kind="info">
          Automatic change detection is unavailable. Use Reload from disk to
          check for updates.
        </InlineAlert>
      ) : null}
      {route.kind === "files" && files ? (
        <>
          {canWrite ? (
            <div className="ul-create-entry">
              <div className="ul-toolbar">
                <button
                  className="ul-button ul-button-secondary"
                  onClick={() => {
                    setCreateKind("file");
                    setCreateName("");
                    setCreateError(undefined);
                  }}
                  type="button"
                >
                  New file
                </button>
                <button
                  className="ul-button ul-button-secondary"
                  onClick={() => {
                    setCreateKind("folder");
                    setCreateName("");
                    setCreateError(undefined);
                  }}
                  type="button"
                >
                  New folder
                </button>
              </div>
              {createKind ? (
                <form
                  aria-label={`Create ${createKind}`}
                  className="ul-create-entry-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createEntry();
                  }}
                >
                  <label htmlFor="ul-create-entry-name">
                    {createKind === "file" ? "File name" : "Folder name"}
                  </label>
                  <input
                    autoFocus
                    className="ul-input"
                    id="ul-create-entry-name"
                    onChange={(event) => setCreateName(event.target.value)}
                    placeholder={createKind === "file" ? "analysis.py" : "data"}
                    value={createName}
                  />
                  <button
                    className="ul-button"
                    disabled={creating || !createName.trim()}
                    type="submit"
                  >
                    {creating ? "Creating..." : `Create ${createKind}`}
                  </button>
                  <button
                    className="ul-button ul-button-secondary"
                    disabled={creating}
                    onClick={() => {
                      setCreateKind(undefined);
                      setCreateError(undefined);
                    }}
                    type="button"
                  >
                    Cancel
                  </button>
                </form>
              ) : null}
              {createError ? (
                <InlineAlert kind="error">{createError}</InlineAlert>
              ) : null}
            </div>
          ) : null}
          <DirectoryView
            files={files}
            path={route.path}
            project={project}
            truncated={truncated}
          />
        </>
      ) : notebook && notebookContents != null ? (
        executeNotebook ? (
          <ChunkErrorBoundary label="Executable notebook">
            <Suspense
              fallback={<LoadingState label="Loading notebook tools" />}
            >
              <div className="ul-file-view-header">
                <button
                  className="ul-button ul-button-secondary"
                  onClick={() => setExecuteNotebook(false)}
                  type="button"
                >
                  Read-only view
                </button>
              </div>
              <NotebookEditor
                baseContents={notebookContents}
                externalChanged={externalChanged}
                filesystem={filesystem!}
                notebook={notebook}
                onDirtyChange={setDirty}
                onExternalConflict={() => setExternalChanged(true)}
                onSaved={(savedNotebook, savedContents) => {
                  markLocalSave();
                  setNotebook(savedNotebook);
                  setNotebookContents(savedContents);
                }}
                path={route.path}
                project={project}
                readOnly={!notebookEditable || !canWrite}
                ref={notebookEditorRef}
                session={session}
              />
            </Suspense>
          </ChunkErrorBoundary>
        ) : (
          <>
            <div className="ul-file-view-header">
              <span className="ul-muted">Safe read-only notebook view</span>
              <button
                className="ul-button ul-button-secondary"
                onClick={() => setExecuteNotebook(true)}
                type="button"
              >
                Edit or run notebook
              </button>
            </div>
            <NotebookView notebook={notebook} />
          </>
        )
      ) : contents != null ? (
        <ChunkErrorBoundary label="Code viewer">
          <Suspense fallback={<LoadingState label="Loading code viewer" />}>
            <CodeView
              contents={contents}
              externalChanged={externalChanged}
              filesystem={filesystem!}
              onDirtyChange={setDirty}
              onEditingChange={setCodeEditing}
              onExternalConflict={() => setExternalChanged(true)}
              onSaved={(saved) => {
                markLocalSave();
                setContents(saved);
              }}
              path={route.path}
              project={project}
              readOnly={!editable || !canWrite}
              ref={codeViewRef}
              session={session}
            />
          </Suspense>
        </ChunkErrorBoundary>
      ) : null}
    </main>
  );
}
