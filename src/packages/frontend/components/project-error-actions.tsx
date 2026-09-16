/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createContext, useContext, type ReactNode } from "react";

interface ProjectErrorActions {
  projectId: string;
  restartProject: () => Promise<void> | void;
}

const Context = createContext<ProjectErrorActions | null>(null);

export function ProjectErrorActionsProvider({
  children,
  projectId,
  restartProject,
}: ProjectErrorActions & { children: ReactNode }) {
  return (
    <Context.Provider value={{ projectId, restartProject }}>
      {children}
    </Context.Provider>
  );
}

export function useProjectErrorActions(): ProjectErrorActions | null {
  return useContext(Context);
}
