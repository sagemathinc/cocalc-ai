/*
 * Hook for chat composer drafts using the shared draft controller architecture.
 * Draft text is private/account-scoped in AKV and survives refreshes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AkvDraftAdapter,
  DraftController,
} from "@cocalc/frontend/drafts";
import {
  get_local_storage,
  set_local_storage,
  delete_local_storage,
} from "@cocalc/frontend/misc";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const CHAT_DRAFT_STORE = "chat-composer-drafts-v1";
const CHAT_DRAFT_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const MAX_LOCAL_DRAFT_CHARS = 200_000;
const MAX_SHADOW_ENTRIES = 500;
const LOCAL_WRITE_DEBOUNCE_MS = 350;

type ShadowState = {
  text: string;
  updatedAt: number;
};

// Process-local optimistic draft state, used to defeat stale remote reads when
// switching composer keys quickly (e.g., send in new thread then "New Chat").
const shadowDraftState = new Map<string, ShadowState>();

function setShadow(key: string, value: ShadowState): void {
  shadowDraftState.set(key, value);
  if (shadowDraftState.size <= MAX_SHADOW_ENTRIES) return;
  const toDelete = shadowDraftState.size - MAX_SHADOW_ENTRIES;
  const iter = shadowDraftState.keys();
  for (let i = 0; i < toDelete; i++) {
    const next = iter.next();
    if (next.done) break;
    shadowDraftState.delete(next.value);
  }
}

interface UseChatComposerDraftOptions {
  account_id?: string;
  project_id: string;
  path: string;
  composerDraftKey: number;
  debounceMs?: number;
}

interface UseChatComposerDraftResult {
  input: string;
  setInput: (value: string) => void;
  clearInput: () => Promise<void>;
  clearComposerDraft: (draftKey: number) => Promise<void>;
}

export function useChatComposerDraft({
  account_id,
  project_id,
  path,
  composerDraftKey,
  debounceMs,
}: UseChatComposerDraftOptions): UseChatComposerDraftResult {
  const [input, setInputState] = useState("");
  const controllerRef = useRef<DraftController | null>(null);
  const pendingLocalWriteRef = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    value: string;
  }>({ value: "" });

  const storageKey = useMemo(
    () => `${project_id}:${path}:${composerDraftKey}`,
    [project_id, path, composerDraftKey],
  );
  const localStorageKey = useMemo(
    () => `chat-composer-draft:${storageKey}`,
    [storageKey],
  );

  const adapter = useMemo(() => {
    if (!account_id) return null;
    const cn = webapp_client.conat_client.conat();
    const kv = cn.sync.akv<any>({
      account_id,
      name: CHAT_DRAFT_STORE,
    });
    return new AkvDraftAdapter({
      kv,
      defaultTtlMs: CHAT_DRAFT_TTL_MS,
    });
  }, [account_id]);

  useEffect(() => {
    let closed = false;
    const prev = controllerRef.current;
    controllerRef.current = null;
    if (prev) {
      void prev.dispose({ flush: true });
    }
    if (!adapter) {
      setInputState("");
      return;
    }
    const local = get_local_storage(localStorageKey);
    let localText =
      typeof local === "string" ? local : typeof local === "number" ? `${local}` : "";
    let localUpdatedAt = 0;
    const shadow = shadowDraftState.get(storageKey);
    if (shadow && shadow.updatedAt > localUpdatedAt) {
      localText = shadow.text;
      localUpdatedAt = shadow.updatedAt;
    }
    const controller = new DraftController({
      key: storageKey,
      adapter,
      debounceMs,
      initialText: localText,
      initialUpdatedAt: localUpdatedAt,
      onError: (err) => console.warn("chat draft controller error", err),
    });
    controllerRef.current = controller;
    const unsub = controller.subscribe((snapshot) => {
      if (!closed) {
        setShadow(storageKey, {
          text: snapshot.text,
          updatedAt: snapshot.updatedAt,
        });
        setInputState(snapshot.text);
      }
    });
    void controller.init();
    return () => {
      closed = true;
      unsub();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      void controller.dispose({ flush: true });
    };
  }, [adapter, storageKey, debounceMs, localStorageKey]);

  const cancelPendingLocalWrite = useCallback(() => {
    const pending = pendingLocalWriteRef.current;
    if (pending.timer != null) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }, []);

  const scheduleLocalWrite = useCallback(
    (value: string) => {
      cancelPendingLocalWrite();
      if (value.trim().length === 0 || value.length > MAX_LOCAL_DRAFT_CHARS) {
        delete_local_storage(localStorageKey);
        return;
      }
      pendingLocalWriteRef.current.value = value;
      pendingLocalWriteRef.current.timer = setTimeout(() => {
        const text = pendingLocalWriteRef.current.value;
        if (text.trim().length === 0 || text.length > MAX_LOCAL_DRAFT_CHARS) {
          delete_local_storage(localStorageKey);
        } else {
          set_local_storage(localStorageKey, text);
        }
        pendingLocalWriteRef.current.timer = undefined;
      }, LOCAL_WRITE_DEBOUNCE_MS);
    },
    [cancelPendingLocalWrite, localStorageKey],
  );

  useEffect(() => {
    return () => {
      cancelPendingLocalWrite();
    };
  }, [cancelPendingLocalWrite, localStorageKey]);

  const setInput = useCallback((value: string) => {
    const now = Date.now();
    setShadow(storageKey, { text: value, updatedAt: now });
    scheduleLocalWrite(value);
    const controller = controllerRef.current;
    if (!controller) {
      setInputState(value);
      return;
    }
    controller.setText(value);
    controller.setComposing(value.trim().length > 0);
  }, [scheduleLocalWrite, storageKey]);

  const clearInput = useCallback(async () => {
    const now = Date.now();
    cancelPendingLocalWrite();
    setShadow(storageKey, { text: "", updatedAt: now });
    delete_local_storage(localStorageKey);
    const controller = controllerRef.current;
    if (!controller) {
      setInputState("");
      if (adapter) {
        await adapter.save(
          storageKey,
          { text: "", updatedAt: now, composing: false },
          { ttlMs: CHAT_DRAFT_TTL_MS },
        );
      }
      return;
    }
    await controller.clear();
    if (adapter) {
      // Write an explicit empty snapshot so key switches do not reload stale
      // remote text due async clear races.
      await adapter.save(
        storageKey,
        { text: "", updatedAt: now, composing: false },
        { ttlMs: CHAT_DRAFT_TTL_MS },
      );
    }
  }, [adapter, cancelPendingLocalWrite, localStorageKey, storageKey]);

  const clearComposerDraft = useCallback(
    async (draftKey: number) => {
      const key = `${project_id}:${path}:${draftKey}`;
      const localKey = `chat-composer-draft:${key}`;
      const now = Date.now();
      cancelPendingLocalWrite();
      setShadow(key, { text: "", updatedAt: now });
      delete_local_storage(localKey);
      if (!adapter) {
        if (draftKey === composerDraftKey) {
          setInputState("");
        }
        return;
      }
      if (draftKey === composerDraftKey) {
        const controller = controllerRef.current;
        if (!controller) {
          setInputState("");
          return;
        }
        await controller.clear();
        await adapter.save(
          key,
          { text: "", updatedAt: now, composing: false },
          { ttlMs: CHAT_DRAFT_TTL_MS },
        );
        return;
      }
      await adapter.save(
        key,
        { text: "", updatedAt: now, composing: false },
        { ttlMs: CHAT_DRAFT_TTL_MS },
      );
    },
    [adapter, cancelPendingLocalWrite, composerDraftKey, path, project_id],
  );

  return { input, setInput, clearInput, clearComposerDraft };
}
