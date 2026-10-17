/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Notebook Markdown (Markdown cells and text/markdown output) is always
sanitized, whether or not the notebook is trusted, keeping a vetted subset of
inline styles and presentational markup (components/sanitize-presentation.ts).

This wraps only the Markdown renderers: other output (text/html) still follows
the notebook's context.
*/

import type { ReactNode } from "react";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";

export function NotebookMarkdownContext({ children }: { children: ReactNode }) {
  const fileContext = useFileContext();
  return (
    <FileContext.Provider
      value={{ ...fileContext, noSanitize: false, allowSafeStyles: true }}
    >
      {children}
    </FileContext.Provider>
  );
}
