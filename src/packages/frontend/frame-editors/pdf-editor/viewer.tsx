/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux, useCallback } from "@cocalc/frontend/app-framework";
import { Path } from "@cocalc/frontend/frame-editors/frame-tree/path";
import { PDFEmbed } from "@cocalc/frontend/frame-editors/latex-editor/pdf-embed";
import { PDFJS } from "@cocalc/frontend/frame-editors/latex-editor/pdfjs";
import { useReloadFileWhenVisible } from "@cocalc/frontend/editors/viewer-file-hooks";
import type { EditorComponentProps } from "../frame-tree/types";
import type { ReactNode } from "react";

function StandalonePDFViewerFrame({
  children,
  path,
  project_id,
}: {
  children: ReactNode;
  path: string;
  project_id: string;
}) {
  return (
    <div
      className="smc-vfill"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <Path project_id={project_id} path={path} />
      <div style={{ flex: "1 1 auto", minHeight: 0 }}>{children}</div>
    </div>
  );
}

function usePDFReloadOnVisible(props: EditorComponentProps) {
  const reload = useCallback(() => {
    props.actions?.reload?.(props.id);
  }, [props.actions, props.id]);
  const stat = useCallback(
    async (path: string) => {
      const fs = redux.getProjectActions(props.project_id)?.fs?.();
      if (typeof fs?.stat !== "function") {
        throw Error("project filesystem is not available");
      }
      return await fs.stat(path);
    },
    [props.project_id],
  );

  useReloadFileWhenVisible({
    is_visible: props.is_visible,
    path: props.path,
    stat,
    reload,
  });
}

export function StandalonePDFJS(props: EditorComponentProps) {
  usePDFReloadOnVisible(props);
  return (
    <StandalonePDFViewerFrame project_id={props.project_id} path={props.path}>
      <PDFJS {...(props as any)} />
    </StandalonePDFViewerFrame>
  );
}

export function StandalonePDFEmbed(props: EditorComponentProps) {
  usePDFReloadOnVisible(props);
  return (
    <StandalonePDFViewerFrame project_id={props.project_id} path={props.path}>
      <PDFEmbed {...(props as any)} />
    </StandalonePDFViewerFrame>
  );
}
