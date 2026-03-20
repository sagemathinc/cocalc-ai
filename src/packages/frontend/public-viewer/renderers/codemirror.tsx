/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { JSX } from "react";
import { CodeMirrorStatic } from "@cocalc/frontend/jupyter/codemirror-static";

export default function PublicViewerCodeMirrorRenderer({
  content,
  fontSize,
  lineNumbers,
  mode,
}: {
  content: string;
  fontSize?: number;
  lineNumbers: boolean;
  mode?: string;
}): JSX.Element {
  return (
    <CodeMirrorStatic
      value={content}
      font_size={fontSize}
      options={{ lineNumbers, mode }}
    />
  );
}
