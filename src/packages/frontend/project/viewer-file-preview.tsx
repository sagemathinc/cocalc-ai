/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button } from "antd";
import { useEffect, useMemo, useState } from "react";
import { Loading } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import PublicViewerFileContents from "@cocalc/frontend/public-viewer/file-contents";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { filename_extension } from "@cocalc/util/misc";
import {
  isAudio,
  isImage,
  isPDF,
  isVideo,
} from "@cocalc/frontend/file-extensions";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { COLORS } from "@cocalc/util/theme";

interface Props {
  project_id: string;
  path: string;
}

interface PreviewState {
  loading: boolean;
  error?: string;
  content?: string;
  rawUrl?: string;
}

export default function ViewerFilePreview({ project_id, path }: Props) {
  const [state, setState] = useState<PreviewState>({ loading: true });
  const [reload, setReload] = useState(0);
  const { publicDirectoryShare } = useProjectContext();
  const share_id = publicDirectoryShare?.id;

  useEffect(() => {
    let cancelled = false;
    let rawUrl: string | undefined;

    async function load() {
      setState({ loading: true });
      try {
        const fs = await webapp_client.conat_client.projectFs({
          project_id,
          caller: "ViewerFilePreview",
          share_id,
          viewer: true,
        });
        const ext = filename_extension(path).toLowerCase();
        if (isImage(ext) || isVideo(ext) || isAudio(ext) || isPDF(ext)) {
          const raw = await fs.readFile(path);
          rawUrl = URL.createObjectURL(
            new Blob([toBlobPart(raw)], { type: mediaMimeType(ext) }),
          );
          if (!cancelled) {
            setState({ loading: false, rawUrl });
          }
          return;
        }
        const raw = await fs.readFile(path, "utf8");
        const content =
          typeof raw === "string"
            ? raw
            : ((raw as any)?.toString?.("utf8") ?? `${raw ?? ""}`);
        rawUrl = URL.createObjectURL(
          new Blob([content], { type: "text/plain" }),
        );
        if (!cancelled) {
          setState({ loading: false, content, rawUrl });
        }
      } catch (err) {
        if (!cancelled) {
          setState({ loading: false, error: `${err}` });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (rawUrl != null) {
        URL.revokeObjectURL(rawUrl);
      }
    };
  }, [project_id, path, reload, share_id]);

  const fileContext = useMemo(
    () => ({
      project_id,
      path,
      noSanitize: true,
      disableExtraButtons: true,
      disableMarkdownCodebar: true,
      client: webapp_client,
    }),
    [project_id, path],
  );

  if (state.loading) {
    return (
      <div
        style={{
          height: "100%",
          overflow: "auto",
          background: COLORS.TOP_BAR.ACTIVE,
        }}
      >
        <ViewerReloadButton loading onReload={() => setReload((n) => n + 1)} />
        <Loading theme="medium" />
      </div>
    );
  }
  if (state.error) {
    return (
      <div
        style={{
          height: "100%",
          overflow: "auto",
          background: COLORS.TOP_BAR.ACTIVE,
        }}
      >
        <ViewerReloadButton onReload={() => setReload((n) => n + 1)} />
        <Alert
          showIcon
          type="error"
          style={{ margin: "24px" }}
          message="Unable to open read-only preview"
          description={state.error}
        />
      </div>
    );
  }

  return (
    <FileContext.Provider value={fileContext}>
      <div
        style={{
          height: "100%",
          overflow: "auto",
          background: COLORS.TOP_BAR.ACTIVE,
        }}
      >
        <ViewerReloadButton onReload={() => setReload((n) => n + 1)} />
        <PublicViewerFileContents
          path={path}
          rawUrl={state.rawUrl ?? "#"}
          content={state.content}
          fileContext={fileContext}
          style={{ height: "100%" }}
        />
      </div>
    </FileContext.Provider>
  );
}

function ViewerReloadButton({
  loading,
  onReload,
}: {
  loading?: boolean;
  onReload: () => void;
}) {
  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 1,
        padding: "8px 12px",
        borderBottom: `1px solid ${COLORS.GRAY_L}`,
        background: COLORS.TOP_BAR.ACTIVE,
      }}
    >
      <Button size="small" disabled={loading} onClick={onReload}>
        <Icon name={loading ? "spinner" : "refresh"} spin={loading} /> Reload
      </Button>
    </div>
  );
}

function toBlobPart(data: unknown): BlobPart {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copy;
  }
  if (
    data != null &&
    typeof data === "object" &&
    Array.isArray((data as any).data)
  ) {
    return new Uint8Array((data as any).data);
  }
  return String(data ?? "");
}

function mediaMimeType(ext: string): string {
  if (isPDF(ext)) return "application/pdf";
  if (isImage(ext)) return `image/${ext === "jpg" ? "jpeg" : ext}`;
  if (isVideo(ext)) return `video/${ext}`;
  if (isAudio(ext)) return `audio/${ext}`;
  return "application/octet-stream";
}
