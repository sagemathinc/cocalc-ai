import { useEffect, useState } from "react";
import { Alert, Button, Space } from "antd";
import type { ArtifactRecord } from "@cocalc/chat";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import PublicViewerFileContents from "@cocalc/frontend/public-viewer/file-contents";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

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
  return TEXT_EXTENSIONS.has(path.split(".").pop()?.toLowerCase() ?? "");
}

export function FileArtifact({
  artifact,
  historical,
}: {
  artifact: ArtifactRecord;
  historical: boolean;
}) {
  const { actions } = useProjectContext();
  const context = useFileContext();
  const path = artifact.file!.path;
  const [loaded, setLoaded] = useState<{ path: string; content: string }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const supported = fileArtifactPreviewSupported(path);
  useEffect(() => {
    let cancelled = false;
    setError("");
    if (!supported) return;
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
  }, [actions, path, refresh, supported]);
  return (
    <div
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
        <span role="status">
          {loading ? "Loading current saved file..." : "Current saved file"}
        </span>
      </Space>
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
      <div style={{ overflow: "auto", flex: "1 1 0", minHeight: 0 }}>
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
          {loaded?.path === path && (
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
    </div>
  );
}
