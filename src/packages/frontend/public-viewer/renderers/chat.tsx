/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo } from "react";
import type { CSSProperties, JSX } from "react";
import ChatViewer from "@cocalc/frontend/chat/viewer";
import { parseChatPreviewRows } from "@cocalc/frontend/chat/preview";
import type { IFileContext } from "@cocalc/frontend/lib/file-context";
import type { Document } from "@cocalc/sync/editor/generic/types";
import { withViewerFileContext } from "../viewer-file-context";

export function createChatViewerDocument(content: string): Document {
  const rows = parseChatPreviewRows(content).rows;
  return {
    get: () => rows,
    to_str: () => content,
  } as unknown as Document;
}

export default function PublicViewerChatRenderer({
  content,
  style,
  fileContext,
}: {
  content: string;
  style?: CSSProperties;
  fileContext: IFileContext;
}): JSX.Element {
  const doc = useMemo(() => {
    const parsed = createChatViewerDocument(content);
    return () => parsed;
  }, [content]);

  return withViewerFileContext(
    <div
      style={{
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        padding: "12px 16px",
        ...style,
      }}
    >
      <ChatViewer doc={doc} readOnly virtualized={false} showThreadList />
    </div>,
    fileContext,
  );
}
