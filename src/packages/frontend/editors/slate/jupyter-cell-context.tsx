/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";

export interface JupyterCellChromeInfo {
  execCount?: string;
  runtimeLabel?: string;
  running?: boolean;
}

export type JupyterGapCursor = {
  index: number;
  side: "before" | "after";
};

export interface JupyterCellContextValue {
  renderOutput?: (cellId: string) => React.ReactNode;
  selectedCellId?: string;
  setSelectedCellId?: (cellId?: string) => void;
  hoveredCellId?: string;
  setHoveredCellId?: (cellId?: string) => void;
  gapCursor?: JupyterGapCursor | null;
  setGapCursor?: (cursor: JupyterGapCursor | null) => void;
  runCell?: (cellId: string, opts?: { insertBelow?: boolean }) => void;
  getCellChromeInfo?: (cellId: string) => JupyterCellChromeInfo;
}

export const JupyterCellContext = React.createContext<JupyterCellContextValue>({});

export function useJupyterCellContext(): JupyterCellContextValue {
  return React.useContext(JupyterCellContext);
}
