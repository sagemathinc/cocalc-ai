/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";

import * as LS from "@cocalc/frontend/misc/local-storage-typed";

const AUTO_SUBMIT_LS_KEY = "AI-CODEX-ASSISTANT-AUTO-SUBMIT:v1";

export function useAgentAutoSubmit(): [boolean, (value: boolean) => void] {
  const [autoSubmit, setAutoSubmit] = useState<boolean>(() => {
    const stored = LS.get<boolean>(AUTO_SUBMIT_LS_KEY);
    return stored == null ? true : stored !== false;
  });

  useEffect(() => {
    LS.set(AUTO_SUBMIT_LS_KEY, autoSubmit);
  }, [autoSubmit]);

  return [autoSubmit, setAutoSubmit];
}
