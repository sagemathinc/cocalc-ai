/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, JSX } from "react";
import type { IFileContext } from "@cocalc/frontend/lib/file-context";
import Markdown from "@cocalc/frontend/editors/slate/static-markdown";
import { withViewerFileContext } from "../viewer-file-context";

export default function PublicViewerMarkdownRenderer({
  content,
  style,
  fileContext,
}: {
  content: string;
  style?: CSSProperties;
  fileContext: IFileContext;
}): JSX.Element {
  return withViewerFileContext(
    <Markdown value={content} style={style} />,
    fileContext,
  );
}
