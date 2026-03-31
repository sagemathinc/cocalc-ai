/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, JSX } from "react";
import type { IFileContext } from "@cocalc/frontend/lib/file-context";
import JupyterNotebook from "@cocalc/frontend/jupyter/nbviewer/public-nbviewer";
import { withViewerFileContext } from "../viewer-file-context";

export default function PublicViewerIpynbRenderer({
  content,
  style,
  fileContext,
}: {
  content: string;
  style?: CSSProperties;
  fileContext: IFileContext;
}): JSX.Element {
  return withViewerFileContext(
    <JupyterNotebook content={content} style={style} />,
    fileContext,
  );
}
