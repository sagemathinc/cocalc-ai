/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";

export interface JupyterCellContextValue {
  renderOutput?: (cellId: string) => React.ReactNode;
}

export const JupyterCellContext = React.createContext<JupyterCellContextValue>({});

export function useJupyterCellContext(): JupyterCellContextValue {
  return React.useContext(JupyterCellContext);
}
