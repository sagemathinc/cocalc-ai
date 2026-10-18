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

text/html output has its own path (output-messages/html-output.tsx, trust-free
step 2a): faithful HTML renders inline under this context, and anything that
sanitizing would change renders in an opaque frame, whatever the trust.

Exception:
- ipywidgets render in their own React root with their own context
  (widgets/manager.ts, sanitized only when untrusted), until widgets get their own path
  (step 4).
*/

import type { ReactNode } from "react";
import {
  FileContext,
  type IFileContext,
  useFileContext,
} from "@cocalc/frontend/lib/file-context";

export function NotebookFileContext({
  value,
  children,
}: {
  // Accepted for callers; nothing here depends on trust any more.
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
      }}
    >
      {children}
    </FileContext.Provider>
  );
}
