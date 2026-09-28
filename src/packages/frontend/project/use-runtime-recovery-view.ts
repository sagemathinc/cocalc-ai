/*
 *  This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { useEffect } from "react";
import { registerForegroundProjectRuntimeView } from "./runtime-recovery";

export function useRuntimeRecoveryView(projectId: string, active: boolean) {
  useEffect(() => {
    if (active) {
      return registerForegroundProjectRuntimeView(projectId);
    }
  }, [projectId, active]);
}
