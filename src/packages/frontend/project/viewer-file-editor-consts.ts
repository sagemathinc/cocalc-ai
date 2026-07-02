/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const VIEWER_FILE_EDITOR_EXTENSION = "cocalc-viewer";

const PUBLIC_VIEWER_EXTENSIONS = new Set([
  "board",
  "chat",
  "html",
  "ipynb",
  "markdown",
  "md",
  "pdf",
  "sage-chat",
  "slides",
  "tasks",
]);

export function shouldUsePublicViewerFileEditor(ext?: string): boolean {
  return PUBLIC_VIEWER_EXTENSIONS.has(`${ext ?? ""}`.trim().toLowerCase());
}
