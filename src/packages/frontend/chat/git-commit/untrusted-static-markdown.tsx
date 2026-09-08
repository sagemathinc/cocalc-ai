/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import type { ComponentProps } from "react";

// Review content can be imported or restored from remote account storage. It
// must not inherit the trusted-project-file Markdown policy from the chat frame.
export function UntrustedStaticMarkdown(
  props: ComponentProps<typeof StaticMarkdown>,
) {
  const fileContext = useFileContext();
  return (
    <FileContext.Provider value={{ ...fileContext, noSanitize: false }}>
      <StaticMarkdown {...props} />
    </FileContext.Provider>
  );
}
