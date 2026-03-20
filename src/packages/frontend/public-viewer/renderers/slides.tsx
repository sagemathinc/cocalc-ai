/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { JSX } from "react";
import type { IFileContext } from "@cocalc/frontend/lib/file-context";
import Slides from "@cocalc/frontend/frame-editors/slides-editor/share";
import { withViewerFileContext } from "../viewer-file-context";

export default function PublicViewerSlidesRenderer({
  content,
  fileContext,
}: {
  content: string;
  fileContext: IFileContext;
}): JSX.Element {
  return withViewerFileContext(<Slides content={content} />, fileContext);
}
