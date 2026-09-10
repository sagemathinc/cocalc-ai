import { useEffect, useRef, useState } from "react";
import { Alert, Button, Space } from "antd";
import { ARTIFACT_TEXT_LIMIT } from "@cocalc/chat";
import type { ArtifactFeedback, ArtifactRecord } from "@cocalc/chat";
import {
  captureArtifactSelection,
  extendArtifactSelection,
} from "@cocalc/frontend/chat/artifact-selection";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import PublicViewerFileContents from "@cocalc/frontend/public-viewer/file-contents";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { useProjectHostAuthedUrl } from "@cocalc/frontend/project/use-project-host-authed-url";
import { viewerRawFileUrl } from "@cocalc/frontend/project/viewer-file-editor";

const BINARY_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "pdf"]);

const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "py",
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "yaml",
  "yml",
  "toml",
  "tex",
  "csv",
  "sh",
  "rs",
  "c",
  "h",
  "cpp",
  "sql",
  "log",
]);
export function fileArtifactPreviewSupported(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext) || BINARY_EXTENSIONS.has(ext);
}

export function FileArtifact({
  artifact,
  historical,
  onComment,
  projectId,
}: {
  artifact: ArtifactRecord;
  historical: boolean;
  projectId?: string;
  onComment?: (feedback: ArtifactFeedback) => Promise<void>;
}) {
  const { actions, projectAccess } = useProjectContext();
  const context = useFileContext();
  const path = artifact.file!.path;
  const [loaded, setLoaded] = useState<{ path: string; content: string }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const binary = BINARY_EXTENSIONS.has(
    path.split(".").pop()?.toLowerCase() ?? "",
  );
  const binaryUrl = useProjectHostAuthedUrl({
    project_id: projectId ?? "",
    url:
      binary && projectId
        ? `${viewerRawFileUrl({ project_id: projectId, path, viewer: projectAccess?.role === "viewer" })}${projectAccess?.role === "viewer" ? "&" : "?"}artifactRefresh=${refresh}`
        : undefined,
  });
  const contentRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<ArtifactFeedback>();
  const displayedRef = useRef<{ path: string; content: string } | undefined>(
    undefined,
  );
  displayedRef.current = loaded;
  useEffect(() => {
    const capture = () => {
      const value = displayedRef.current;
      const range = window.getSelection();
      if (
        !value ||
        value.path !== path ||
        !contentRef.current ||
        !range ||
        range.isCollapsed ||
        !contentRef.current.contains(range.anchorNode) ||
        !contentRef.current.contains(range.focusNode)
      )
        return;
      try {
        setSelection(
          captureArtifactSelection(
            contentRef.current,
            { ...artifact, input: value.content },
            range,
          ),
        );
      } catch (err) {
        setError(String(err));
      }
    };
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, [path, artifact]);
  useEffect(() => {
    setSelection(undefined);
  }, [path]);
  const supported = fileArtifactPreviewSupported(path);
  useEffect(() => {
    let cancelled = false;
    setError("");
    if (!supported || binary) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const fs = actions?.fs();
        if (!fs) throw Error("Project filesystem unavailable");
        const stat = await fs.stat(path);
        if (stat.size > 1024 * 1024)
          throw Error(
            "File exceeds the 1 MiB preview limit. Open the file to read it.",
          );
        const raw = await fs.readFile(path, "utf8");
        const content = typeof raw === "string" ? raw : raw.toString();
        if (new TextEncoder().encode(content).length > 1024 * 1024)
          throw Error("File exceeds the preview limit");
        if (!cancelled) setLoaded({ path, content });
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, path, refresh, supported, binary]);
  return (
    <KeyboardBoundary
      className="smc-vfill"
      style={{
        minHeight: 0,
        padding: 12,
        color: UI_COLORS.text,
        background: UI_COLORS.surface,
      }}
    >
      <Space wrap style={{ flexShrink: 0, marginBottom: 8 }}>
        <strong>{artifact.title}</strong>
        <Button
          onClick={() => {
            void actions
              ?.open_file({ path })
              .catch((err) => setError(String(err)));
          }}
        >
          Open file
        </Button>
        <Button
          disabled={loading || !supported}
          onClick={() => setRefresh((n) => n + 1)}
        >
          Refresh
        </Button>
        <Button
          disabled={
            !onComment ||
            binary ||
            loaded?.path !== path ||
            new TextEncoder().encode(loaded?.content ?? "").length >
              ARTIFACT_TEXT_LIMIT
          }
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (!onComment || !contentRef.current || loaded?.path !== path)
              return;
            try {
              const feedback =
                selection ??
                captureArtifactSelection(
                  contentRef.current,
                  { ...artifact, input: loaded.content },
                  window.getSelection(),
                );
              void onComment(feedback).catch((err) => setError(String(err)));
            } catch (err) {
              setError(String(err));
            }
          }}
        >
          Comment
        </Button>
        {selection && (
          <Button
            onClick={() => {
              setSelection(undefined);
              window.getSelection()?.removeAllRanges();
            }}
          >
            Clear selection
          </Button>
        )}
        <span role="status">
          {loading ? "Loading current saved file..." : "Current saved file"}
        </span>
      </Space>
      {selection && (
        <div role="note">
          Comment uses the selected saved-file snapshot, even after refresh.
        </div>
      )}
      <div style={{ overflowWrap: "anywhere", flexShrink: 0 }}>{path}</div>
      {historical && (
        <div role="note">
          Published file reference; the contents shown are current, not a
          historical snapshot.
        </div>
      )}
      {error && (
        <Alert
          type="warning"
          title={error}
          description={
            loaded?.path === path
              ? "The previous preview is retained and may be stale."
              : undefined
          }
        />
      )}
      {!supported && (
        <div role="status">
          Preview is not yet supported for this file type. Use Open file.
        </div>
      )}
      <div
        ref={contentRef}
        role="document"
        aria-label="File preview"
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            event.target === event.currentTarget &&
            event.shiftKey &&
            extendArtifactSelection(
              event.currentTarget,
              window.getSelection(),
              event.key,
              event.ctrlKey || event.metaKey,
            )
          )
            event.preventDefault();
        }}
        style={{ overflow: "auto", flex: "1 1 0", minHeight: 0 }}
      >
        <FileContext.Provider
          value={{
            ...context,
            noSanitize: false,
            disableMarkdownCodebar: true,
            urlTransform: (url, tag) =>
              tag?.toLowerCase() === "img"
                ? ""
                : context.urlTransform?.(url, tag),
          }}
        >
          {binary && !binaryUrl && (
            <div role="status">Preparing file preview...</div>
          )}
          {binary && binaryUrl && (
            <PublicViewerFileContents
              path={path}
              rawUrl={binaryUrl}
              style={{ height: "100%" }}
              fileContext={{ noSanitize: false }}
            />
          )}
          {!binary && loaded?.path === path && (
            <PublicViewerFileContents
              content={loaded.content}
              path={path}
              rawUrl=""
              fileContext={{
                ...context,
                noSanitize: false,
                disableMarkdownCodebar: true,
                urlTransform: (url, tag) =>
                  tag?.toLowerCase() === "img"
                    ? ""
                    : context.urlTransform?.(url, tag),
              }}
            />
          )}
        </FileContext.Provider>
      </div>
    </KeyboardBoundary>
  );
}
