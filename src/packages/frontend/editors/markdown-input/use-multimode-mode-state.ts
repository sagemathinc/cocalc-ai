import LRU from "lru-cache";
import { useEffect, useRef, useState } from "react";
import { get_local_storage, set_local_storage } from "@cocalc/frontend/misc";
import type { Mode } from "./types";

interface MultimodeState {
  mode?: Mode;
  markdown?: any;
  editor?: any;
}

const multimodeStateCache = new LRU<string, MultimodeState>({ max: 500 });
const MODES = ["markdown", "editor"] as const;
const LOCAL_STORAGE_KEY = "markdown-editor-mode";

function getLocalStorageMode(): Mode | undefined {
  const mode = get_local_storage(LOCAL_STORAGE_KEY);
  if (typeof mode === "string" && MODES.includes(mode as any)) {
    return mode as Mode;
  }
}

interface UseMultimodeModeStateOptions {
  cacheId?: string;
  projectId?: string;
  path?: string;
  defaultMode?: Mode;
  fixedMode?: Mode;
  fallbackMode: Mode;
  onModeChange?: (mode: Mode) => void;
}

export function useMultimodeModeState({
  cacheId,
  projectId,
  path,
  defaultMode,
  fixedMode,
  fallbackMode,
  onModeChange,
}: UseMultimodeModeStateOptions) {
  const activeModeRef = useRef<Mode>("markdown");
  const reportedModeRef = useRef<Mode | null>(null);

  function getKey() {
    return `${projectId}${path}:${cacheId}`;
  }

  function getCache() {
    return cacheId == null ? undefined : multimodeStateCache.get(getKey());
  }

  const [mode, setModeState] = useState<Mode>(
    fixedMode ??
      getCache()?.mode ??
      defaultMode ??
      getLocalStorageMode() ??
      fallbackMode,
  );

  activeModeRef.current = mode;

  useEffect(() => {
    if (reportedModeRef.current === mode) {
      return;
    }
    reportedModeRef.current = mode;
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  function setMode(nextMode: Mode) {
    if (activeModeRef.current === nextMode) {
      return;
    }
    set_local_storage(LOCAL_STORAGE_KEY, nextMode);
    setModeState(nextMode);
    if (cacheId !== undefined) {
      multimodeStateCache.set(getKey(), {
        ...getCache(),
        mode: nextMode,
      });
    }
  }

  return {
    activeModeRef,
    mode,
    setMode,
    getCachedSelection: () => getCache()?.[mode],
    saveCachedSelection: (selection: any) => {
      if (cacheId == null) {
        return;
      }
      multimodeStateCache.set(getKey(), {
        ...getCache(),
        [mode]: selection,
      });
    },
  };
}
