/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
What a notebook provides to everything it renders (cell-list.tsx).

Notebook Markdown -- cells in every view and edit mode, text/markdown and
text/latex output, anything rendered with the Markdown or HTML renderers -- is
always sanitized, whether or not the notebook is trusted, keeping a vetted
subset of inline styles and presentational markup
(components/sanitize-presentation.ts).  This fails closed: a renderer added
later is sanitized too.

The one exception, until HTML output gets its own path (trust-free notebooks
step 2a): text/html output keeps exactly what it had before, through
LegacyHtmlOutputContext.
*/

import type { ReactNode } from "react";
import {
  FileContext,
  type IFileContext,
  useFileContext,
} from "@cocalc/frontend/lib/file-context";

export function NotebookFileContext({
  trust,
  value,
  children,
}: {
  trust?: boolean;
  value?: Partial<IFileContext>;
  children: ReactNode;
}) {
  const fileContext = useFileContext();
  return (
    <FileContext.Provider
      value={{
        ...fileContext,
        ...value,
        noSanitize: false,
        allowSafeStyles: true,
        legacyHtmlOutputNoSanitize: !!trust,
      }}
    >
      {children}
    </FileContext.Provider>
  );
}

// For the text/html output handlers: inside a notebook, the context HTML
// output had before NotebookFileContext (sanitized unless trusted, no safe
// styles); elsewhere (e.g., the public viewer), the context unchanged.
export function LegacyHtmlOutputContext({ children }: { children: ReactNode }) {
  const fileContext = useFileContext();
  const legacy = fileContext.legacyHtmlOutputNoSanitize;
  if (legacy == null) {
    return <>{children}</>;
  }
  return (
    <FileContext.Provider
      value={{
        ...fileContext,
        noSanitize: legacy,
        allowSafeStyles: false,
        legacyHtmlOutputNoSanitize: undefined,
      }}
    >
      {children}
    </FileContext.Provider>
  );
}
