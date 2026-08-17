/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useEffectEvent, useRef } from "react";

const IDLE_CHECKPOINT_MS = 10_000;
const MAX_CHECKPOINT_MS = 30_000;

export default function useEditCheckpoint({
  active,
  revision,
  save,
}: {
  active: boolean;
  revision: number;
  save: () => void | Promise<void>;
}): void {
  const saveCheckpoint = useEffectEvent(save);
  const windowStartedAt = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!active) {
      windowStartedAt.current = undefined;
      return;
    }
    const now = Date.now();
    windowStartedAt.current ??= now;
    const maximumRemaining = Math.max(
      0,
      MAX_CHECKPOINT_MS - (now - windowStartedAt.current),
    );
    const timer = window.setTimeout(
      () => void saveCheckpoint(),
      Math.min(IDLE_CHECKPOINT_MS, maximumRemaining),
    );
    return () => window.clearTimeout(timer);
  }, [active, revision]);
}
