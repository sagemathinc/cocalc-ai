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
  // A public notebook is untrusted content: render its HTML through the
  // central sanitizer, keeping the viewer's URL and link handling, and the
  // vetted safe styles and presentational markup notebooks keep elsewhere.
  return withViewerFileContext(
    <JupyterNotebook content={content} style={style} />,
    { ...fileContext, noSanitize: false, allowSafeStyles: true },
  );
}
