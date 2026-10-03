/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createContext, useContext, type ReactNode } from "react";

// The workspace shell's "show sidebar" control, for pages in its content pane
// that draw their own header (like the Library) instead of the top bar.
export const WorkspaceContentNavigation = createContext<ReactNode>(null);

export function useWorkspaceContentNavigation(): ReactNode {
  return useContext(WorkspaceContentNavigation);
}
