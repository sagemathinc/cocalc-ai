/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { JSX } from "react";
import type { IFileContext } from "@cocalc/frontend/lib/file-context";
import Whiteboard from "@cocalc/frontend/frame-editors/whiteboard-editor/share/index";
import { withViewerFileContext } from "../viewer-file-context";

export default function PublicViewerBoardRenderer({
  content,
  fileContext,
}: {
  content: string;
  fileContext: IFileContext;
}): JSX.Element {
  return withViewerFileContext(<Whiteboard content={content} />, fileContext);
}
