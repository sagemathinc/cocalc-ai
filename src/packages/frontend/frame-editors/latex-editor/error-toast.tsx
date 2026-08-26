/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
How a LaTeX build failure is presented in an error toast.

A toast is one antd notification, and its text runs through
normalizeUserFacingError, which collapses whitespace -- so newlines in a plain
string message are silently flattened into one run-on line.  Structure has to
come from markup instead, which is what RichError carries.

The shape is always the same: a summary of what went wrong for the document,
then the specific LaTeX error that caused it, emphasized.  The summary alone is
not actionable and the cause alone has no context.
*/

import type { RichError } from "@cocalc/frontend/frame-editors/base-editor/actions-base";

// Summaries.  Deliberately not prefixed with "WARNING:" -- the toast is
// already rendered as an error and titled with the filename.
export const NO_PDF = "It is not possible to generate a useful PDF file.";
export const BUILD_FAILED = "Building the document failed.";

export function buildErrorToast(summary: string, cause?: string): RichError {
  const detail = cause?.trim();
  if (!detail || detail === summary) {
    return { node: summary, text: summary };
  }
  return {
    node: (
      <div>
        {summary}
        <div style={{ fontWeight: "bold", marginTop: "5px" }}>{detail}</div>
      </div>
    ),
    text: `${summary} ${detail}`,
  };
}
