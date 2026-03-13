/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { waitForPersistAccountId } from "./persist-account-id";

const MAX_HISTORY = 100;
const DKV_NAME = "explorer-nav-history";

interface PersistedState {
  history: string[];
  cursor: number;
}

interface NavDKV {
  get(key: string): PersistedState | undefined;
  set(key: string, value: PersistedState): void;
  close?(): void;
}

export interface NavigationHistory {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
  recordNavigation: (path: string) => void;
  backHistory: string[];
  forwardHistory: string[];
}

function pushToHistory(
  history: string[],
  cursor: number,
  path: string,
): { history: string[]; cursor: number } {
  let base = cursor > 0 ? history.slice(cursor) : [...history];
  base = base.filter((p) => p !== path);
  base.unshift(path);
  if (base.length > MAX_HISTORY) {
    base.length = MAX_HISTORY;
  }
  return { history: base, cursor: 0 };
}

export function useNavigationHistory(
  project_id: string,
  currentPath: string,
  onNavigate: (path: string) => void,
  storageKey: "explorer" | "flyout",
): NavigationHistory {
  const dkvKey = `${storageKey}:${project_id}`;
  const dkvRef = useRef<NavDKV | null>(null);
  const [initialized, setInitialized] = useState(false);
  const isBackForwardRef = useRef(false);

  const [history, setHistory] = useState<string[]>([currentPath]);
  const [cursor, setCursor] = useState(0);

  const historyRef = useRef(history);
  const cursorRef = useRef(cursor);
  historyRef.current = history;
  cursorRef.current = cursor;

  const persist = useCallback(
    (nextHistory: string[], nextCursor: number) => {
      try {
        dkvRef.current?.set(dkvKey, {
          history: nextHistory,
          cursor: nextCursor,
        });
      } catch {
        // ignore DKV failures
      }
    },
    [dkvKey],
  );

  useEffect(() => {
    let isMounted = true;
    let conatDkv: NavDKV | null = null;

    (async () => {
      if (!isMounted) return;

      const account_id = await waitForPersistAccountId();
      if (!isMounted) return;
      try {
        conatDkv = (await webapp_client.conat_client.dkv<PersistedState>({
          account_id,
          name: DKV_NAME,
        })) as unknown as NavDKV;
        if (!isMounted) {
          conatDkv.close?.();
          return;
        }

        dkvRef.current = conatDkv;
        const saved = conatDkv.get(dkvKey);
        if (saved?.history?.length) {
          let savedHistory = saved.history;
          let savedCursor = saved.cursor ?? 0;
          if (savedHistory[savedCursor] !== currentPath) {
            const merged = pushToHistory(
              savedHistory,
              savedCursor,
              currentPath,
            );
            savedHistory = merged.history;
            savedCursor = merged.cursor;
            try {
              conatDkv.set(dkvKey, {
                history: savedHistory,
                cursor: savedCursor,
              });
            } catch {
              // ignore
            }
          }
          setHistory(savedHistory);
          setCursor(savedCursor);
        }
      } catch {
        // ignore DKV failures
      } finally {
        if (isMounted) {
          setInitialized(true);
        } else {
          conatDkv?.close?.();
        }
      }
    })();

    return () => {
      isMounted = false;
      dkvRef.current?.close?.();
      dkvRef.current = null;
      setInitialized(false);
    };
  }, [currentPath, dkvKey, project_id, storageKey]);

  useEffect(() => {
    if (!initialized) return;
    if (isBackForwardRef.current) {
      isBackForwardRef.current = false;
      return;
    }
    if (history[cursor] === currentPath) return;

    const next = pushToHistory(history, cursor, currentPath);
    setHistory(next.history);
    setCursor(next.cursor);
    persist(next.history, next.cursor);
  }, [currentPath, cursor, history, initialized, persist]);

  const goBack = useCallback(() => {
    const nextHistory = historyRef.current;
    const nextCursor = cursorRef.current + 1;
    if (nextCursor >= nextHistory.length) return;
    setCursor(nextCursor);
    cursorRef.current = nextCursor;
    persist(nextHistory, nextCursor);
    isBackForwardRef.current = true;
    onNavigate(nextHistory[nextCursor]);
  }, [onNavigate, persist]);

  const goForward = useCallback(() => {
    const nextHistory = historyRef.current;
    const nextCursor = cursorRef.current - 1;
    if (nextCursor < 0) return;
    setCursor(nextCursor);
    cursorRef.current = nextCursor;
    persist(nextHistory, nextCursor);
    isBackForwardRef.current = true;
    onNavigate(nextHistory[nextCursor]);
  }, [onNavigate, persist]);

  const recordNavigation = useCallback(
    (path: string) => {
      const next = pushToHistory(historyRef.current, cursorRef.current, path);
      setHistory(next.history);
      setCursor(next.cursor);
      historyRef.current = next.history;
      cursorRef.current = next.cursor;
      persist(next.history, next.cursor);
    },
    [persist],
  );

  return {
    canGoBack: cursor < history.length - 1,
    canGoForward: cursor > 0,
    goBack,
    goForward,
    recordNavigation,
    backHistory: history.slice(cursor + 1),
    forwardHistory: cursor > 0 ? history.slice(0, cursor).reverse() : [],
  };
}
