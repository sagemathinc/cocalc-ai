/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useContext, useEffect, useState } from "react";
import { Alert } from "antd";

import { Loading } from "@cocalc/frontend/components";
import { useReloadFileWhenVisible } from "@cocalc/frontend/editors/viewer-file-hooks";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import PublicViewerFileContents, {
  publicViewerFileNeedsContent,
} from "@cocalc/frontend/public-viewer/file-contents";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { useProjectHostAuthedUrl } from "@cocalc/frontend/project/use-project-host-authed-url";
import { webapp_client } from "@cocalc/frontend/webapp-client";

interface ViewerFileEditorProps {
  project_id: string;
  path: string;
  is_visible?: boolean;
}

export default function ViewerFileEditor({
  project_id,
  path,
  is_visible,
}: ViewerFileEditorProps) {
  const fileContext = useContext(FileContext);
  const { actions } = useProjectContext();
  const [content, setContent] = useState<string | undefined>();
  const [error, setError] = useState<unknown>();
  const [reloadId, setReloadId] = useState(0);
  const needsContent = publicViewerFileNeedsContent(path);
  const rawUrl = useProjectHostAuthedUrl({
    project_id,
    url: webapp_client.project_client.read_file({
      project_id,
      path,
    }),
  });

  const reload = useCallback(() => setReloadId(Date.now()), []);
  const stat = useCallback(
    async (path: string) => {
      const fs = actions?.fs?.();
      if (typeof fs?.stat !== "function") {
        throw Error("project filesystem is not available");
      }
      return await fs.stat(path);
    },
    [actions],
  );

  useReloadFileWhenVisible({
    is_visible,
    path,
    stat,
    reload,
  });

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    if (!needsContent) {
      setContent(undefined);
      return () => {
        cancelled = true;
      };
    }
    async function load() {
      try {
        const fs = actions?.fs?.();
        if (typeof fs?.readFile !== "function") {
          throw Error("project filesystem is not available");
        }
        const raw = await fs.readFile(path, "utf8");
        if (cancelled) return;
        setContent(
          typeof raw === "string"
            ? raw
            : ((raw as any)?.toString?.("utf8") ?? `${raw ?? ""}`),
        );
      } catch (err) {
        if (cancelled) return;
        setError(err);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [actions, needsContent, path, reloadId]);

  if (error != null) {
    return (
      <Alert
        showIcon
        type="error"
        style={{ margin: "16px" }}
        message="Unable to open read-only file"
        description={`${error}`}
      />
    );
  }

  if (needsContent && content == null) {
    return <Loading theme="medium" />;
  }

  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <PublicViewerFileContents
        content={content}
        path={path}
        rawUrl={rawUrl ?? ""}
        fileContext={fileContext}
        lineNumbers={false}
        style={{ minHeight: "100%" }}
      />
    </div>
  );
}
