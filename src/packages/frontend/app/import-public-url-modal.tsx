/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Modal, Space } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { QueryParams } from "@cocalc/frontend/misc/query-params";
import { SelectProject } from "@cocalc/frontend/projects/select-project";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { parsePublicViewerImportUrl } from "@cocalc/util/public-viewer-import";

const IMPORT_PUBLIC_URL_PARAM = "import-public-url";

function getImportPublicUrlFromLocation(): string | undefined {
  return QueryParams.get(IMPORT_PUBLIC_URL_PARAM)?.trim() || undefined;
}

function defaultTargetPath(path: string): string {
  return path.replace(/^\/+/, "") || "imported-file";
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
  const [result, setResult] = useState<{
    project_id: string;
    path: string;
    bytes: number;
  }>();

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
    setTargetPath(parsed.value ? defaultTargetPath(parsed.value.path) : "");
  }, [importUrl, parsed.value?.path]);

  const close = () => {
    QueryParams.remove(IMPORT_PUBLIC_URL_PARAM);
    setImportUrl(undefined);
    setError(undefined);
    setResult(undefined);
    setImporting(false);
  };

  async function onImport() {
    if (!importUrl || !projectId || !targetPath.trim()) {
      return;
    }
    setImporting(true);
    setError(undefined);
    try {
      const next =
        await webapp_client.conat_client.hub.projects.importPublicUrl({
          project_id: projectId,
          public_url: importUrl,
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
              <Button type="primary">Open imported file</Button>
            </a>
          </Space>
        ) : (
          <Space>
            <Button onClick={close}>Cancel</Button>
            <Button
              disabled={!projectId || !targetPath.trim() || !!parsed.error}
              loading={importing}
              onClick={onImport}
              type="primary"
            >
              Copy to my project
            </Button>
          </Space>
        )
      }
      onCancel={close}
      open
      title="Copy to my project"
    >
      {parsed.error ? (
        <Alert message={parsed.error} showIcon type="error" />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            message={parsed.value?.title || parsed.value?.path || "Public file"}
            description={
              <>
                Import from <code>{parsed.value?.rawUrl}</code>
              </>
            }
            showIcon
            type="info"
          />
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
          {error ? <Alert message={error} showIcon type="error" /> : undefined}
          {result ? (
            <Alert
              description={
                <>
                  Imported <code>{result.path}</code> to{" "}
                  <strong>{projectTitle || result.project_id}</strong> (
                  {result.bytes.toLocaleString()} bytes).
                </>
              }
              message="Import complete"
              showIcon
              type="success"
            />
          ) : undefined}
        </Space>
      )}
    </Modal>
  );
}
