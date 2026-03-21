/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Modal, Radio, Space } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { QueryParams } from "@cocalc/frontend/misc/query-params";
import { SelectProject } from "@cocalc/frontend/projects/select-project";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { parsePublicViewerImportUrl } from "@cocalc/util/public-viewer-import";
import { human_readable_size } from "@cocalc/util/misc";
import type {
  ImportPublicPathResult,
  PublicPathInspectionResult,
} from "@cocalc/conat/hub/api/projects";

const IMPORT_PUBLIC_URL_PARAM = "import-public-url";
const LARGE_DIRECTORY_WARNING_BYTES = 250 * 1024 * 1024;

function getImportPublicUrlFromLocation(): string | undefined {
  return QueryParams.get(IMPORT_PUBLIC_URL_PARAM)?.trim() || undefined;
}

function defaultTargetPath(path: string): string {
  return path.replace(/^\/+/, "") || "imported-file";
}

function basename(path: string): string {
  const parts = `${path ?? ""}`.split("/").filter(Boolean);
  return parts.at(-1) ?? "";
}

function encodeProjectPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function importedFileHref(projectId: string, path: string): string {
  return `${appBasePath.replace(/\/+$/, "")}/projects/${projectId}/files/${encodeProjectPath(path)}`;
}

export function ImportPublicUrlModal() {
  const isReady = useTypedRedux("account", "is_ready");
  const isLoggedIn = useTypedRedux("account", "is_logged_in");
  const projectMap = useTypedRedux("projects", "project_map");
  const [importUrl, setImportUrl] = useState<string | undefined>(() =>
    getImportPublicUrlFromLocation(),
  );
  const [projectId, setProjectId] = useState<string>();
  const [targetPath, setTargetPath] = useState<string>("");
  const [error, setError] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [inspection, setInspection] = useState<{
    loading: boolean;
    value?: PublicPathInspectionResult;
    error?: string;
  }>({ loading: false });
  const [importMode, setImportMode] = useState<"file" | "directory">("file");
  const [result, setResult] = useState<ImportPublicPathResult>();

  useEffect(() => {
    const refresh = () => setImportUrl(getImportPublicUrlFromLocation());
    window.addEventListener("popstate", refresh);
    return () => window.removeEventListener("popstate", refresh);
  }, []);

  const parsed = useMemo(() => {
    if (!importUrl) {
      return {};
    }
    try {
      return { value: parsePublicViewerImportUrl(importUrl) };
    } catch (err) {
      return { error: `${err}` };
    }
  }, [importUrl]);

  useEffect(() => {
    setProjectId(undefined);
    setError(undefined);
    setResult(undefined);
    setImporting(false);
    setInspection({ loading: false });
  }, [importUrl, parsed.value?.path]);

  useEffect(() => {
    if (!importUrl || !parsed.value) {
      setInspection({ loading: false });
      return;
    }
    let cancelled = false;
    setInspection({ loading: true });
    void (async () => {
      try {
        const value =
          await webapp_client.conat_client.hub.projects.inspectPublicPath({
            public_url: importUrl,
          });
        if (cancelled) return;
        setInspection({ loading: false, value });
        setImportMode(
          value.requested.kind === "directory" ? "directory" : "file",
        );
      } catch (err) {
        if (cancelled) return;
        setInspection({ loading: false, error: `${err}` });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [importUrl, parsed.value]);

  const defaultPathForMode = useMemo(() => {
    if (!parsed.value) {
      return "";
    }
    if (!inspection.value) {
      return defaultTargetPath(parsed.value.path);
    }
    if (importMode === "directory") {
      const source =
        inspection.value.requested.kind === "directory"
          ? inspection.value.requested
          : inspection.value.containing_directory;
      return (
        basename(source.relative_path) ||
        basename(inspection.value.static_root) ||
        "imported-folder"
      );
    }
    return defaultTargetPath(parsed.value.path);
  }, [parsed.value, inspection.value, importMode]);

  useEffect(() => {
    setTargetPath(defaultPathForMode);
  }, [defaultPathForMode]);

  const close = () => {
    QueryParams.remove(IMPORT_PUBLIC_URL_PARAM);
    setImportUrl(undefined);
    setError(undefined);
    setResult(undefined);
    setImporting(false);
  };

  async function onImport() {
    if (
      !importUrl ||
      !projectId ||
      !targetPath.trim() ||
      !inspection.value ||
      inspection.loading
    ) {
      return;
    }
    setImporting(true);
    setError(undefined);
    try {
      const next =
        await webapp_client.conat_client.hub.projects.importPublicPath({
          project_id: projectId,
          public_url: importUrl,
          mode:
            inspection.value.requested.kind === "directory"
              ? "directory"
              : importMode,
          path: targetPath.trim(),
        });
      setResult(next);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setImporting(false);
    }
  }

  if (!importUrl || !isReady || !isLoggedIn) {
    return null;
  }

  const projectTitle =
    projectId != null
      ? (projectMap?.getIn([projectId, "title"]) as string | undefined)
      : undefined;
  const canCopyDirectory = inspection.value?.requested.kind === "file";
  const selectedSource =
    importMode === "directory" && inspection.value
      ? canCopyDirectory
        ? inspection.value.containing_directory
        : inspection.value.requested
      : inspection.value?.requested;
  const selectedLabel =
    importMode === "directory" ? "containing folder" : "file";
  const selectedSize = selectedSource?.bytes;
  const sizeDescription =
    selectedSize != null
      ? human_readable_size(selectedSize)
      : "size unavailable";

  return (
    <Modal
      destroyOnHidden
      footer={
        result ? (
          <Space>
            <Button onClick={close}>Close</Button>
            <a
              href={importedFileHref(result.project_id, result.path)}
              rel="noreferrer noopener"
            >
              <Button type="primary">Open destination</Button>
            </a>
          </Space>
        ) : (
          <Space>
            <Button onClick={close}>Cancel</Button>
            <Button
              disabled={
                !projectId ||
                !targetPath.trim() ||
                !!parsed.error ||
                !!inspection.error ||
                inspection.loading
              }
              loading={importing}
              onClick={onImport}
              type="primary"
            >
              {importMode === "directory"
                ? "Copy folder to my project"
                : "Copy to my project"}
            </Button>
          </Space>
        )
      }
      onCancel={close}
      open
      title="Copy to my project"
    >
      {parsed.error ? (
        <Alert title={parsed.error} showIcon type="error" />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            title={parsed.value?.title || parsed.value?.path || "Public file"}
            description={
              <>
                Import from <code>{parsed.value?.rawUrl}</code>
              </>
            }
            showIcon
            type="info"
          />
          {inspection.error ? (
            <Alert title={inspection.error} showIcon type="error" />
          ) : undefined}
          {inspection.value ? (
            <div>
              <div style={{ fontWeight: 600, marginBottom: "8px" }}>
                What to copy
              </div>
              <Radio.Group
                disabled={
                  importing ||
                  !!result ||
                  inspection.value.requested.kind === "directory"
                }
                onChange={(e) => setImportMode(e.target.value)}
                value={
                  inspection.value.requested.kind === "directory"
                    ? "directory"
                    : importMode
                }
              >
                <Space direction="vertical">
                  <Radio value="file">
                    Copy this file
                    {inspection.value.requested.bytes != null
                      ? ` (${human_readable_size(inspection.value.requested.bytes)})`
                      : ""}
                  </Radio>
                  {canCopyDirectory ? (
                    <Radio value="directory">
                      Copy containing folder
                      {inspection.value.containing_directory.bytes != null
                        ? ` (${human_readable_size(inspection.value.containing_directory.bytes)})`
                        : ""}
                    </Radio>
                  ) : undefined}
                </Space>
              </Radio.Group>
            </div>
          ) : undefined}
          {inspection.loading ? (
            <Alert title="Inspecting public path..." showIcon type="info" />
          ) : undefined}
          <div>
            <div style={{ fontWeight: 600, marginBottom: "8px" }}>
              Target project
            </div>
            <SelectProject
              onChange={(value) => setProjectId(value)}
              value={projectId}
            />
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: "8px" }}>
              Destination path
            </div>
            <Input
              disabled={importing || !!result}
              onChange={(e) => setTargetPath(e.target.value)}
              placeholder="path/in/project.ext"
              value={targetPath}
            />
          </div>
          {inspection.value && selectedSource ? (
            <Alert
              title={`Ready to copy ${selectedLabel}`}
              description={
                <>
                  Source <code>{selectedSource.container_path}</code>,{" "}
                  {sizeDescription}.
                  {selectedSource.truncated
                    ? " Size estimate may be incomplete."
                    : ""}
                </>
              }
              showIcon
              type="info"
            />
          ) : undefined}
          {inspection.value &&
          importMode === "directory" &&
          (inspection.value.containing_directory.bytes ?? 0) >=
            LARGE_DIRECTORY_WARNING_BYTES ? (
            <Alert
              title="Large folder copy"
              description="This can take a while. Large directory copies run as a background operation, especially when the source and destination are on different hosts."
              showIcon
              type="warning"
            />
          ) : undefined}
          {error ? <Alert title={error} showIcon type="error" /> : undefined}
          {result ? (
            <Alert
              description={
                <>
                  Started copying <code>{result.source_path}</code> to{" "}
                  <strong>{projectTitle || result.project_id}</strong> as{" "}
                  <code>{result.path}</code>. This runs as a background
                  operation.
                </>
              }
              title="Copy started"
              showIcon
              type="success"
            />
          ) : undefined}
        </Space>
      )}
    </Modal>
  );
}
