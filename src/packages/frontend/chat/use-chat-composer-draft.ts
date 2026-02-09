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

type ShadowState = {
  text: string;
  updatedAt: number;
};

function debugChatDraft(type: string, data?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  if (!(window as any).__CHAT_COMPOSER_DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(`[chat-draft] ${type}`, data ?? {});
}

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
    debugChatDraft("controller:init", {
      storageKey,
      localStorageKey,
      localLength: localText.length,
      localUpdatedAt,
      hasShadow: shadow != null,
    });
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
        debugChatDraft("controller:subscribe", {
          storageKey,
          textLength: snapshot.text.length,
          composing: snapshot.composing,
          updatedAt: snapshot.updatedAt,
        });
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

  const setInput = useCallback((value: string) => {
    const now = Date.now();
    debugChatDraft("setInput", {
      storageKey,
      valueLength: value.length,
      sessionTime: now,
    });
    setShadow(storageKey, { text: value, updatedAt: now });
    if (value.trim().length === 0) {
      delete_local_storage(localStorageKey);
    } else if (value.length > MAX_LOCAL_DRAFT_CHARS) {
      // Avoid unbounded localStorage growth; AKV still stores the full draft.
      delete_local_storage(localStorageKey);
    } else {
      set_local_storage(localStorageKey, value);
    }
    const controller = controllerRef.current;
    if (!controller) {
      setInputState(value);
      return;
    }
    controller.setText(value);
    controller.setComposing(value.trim().length > 0);
  }, [localStorageKey, storageKey]);

  const clearInput = useCallback(async () => {
    const now = Date.now();
    debugChatDraft("clearInput:start", {
      storageKey,
      localStorageKey,
      sessionTime: now,
    });
    setShadow(storageKey, { text: "", updatedAt: now });
    delete_local_storage(localStorageKey);
    const controller = controllerRef.current;
    if (!controller) {
      setInputState("");
      if (adapter) {
        debugChatDraft("clearInput:save-empty-no-controller", {
          storageKey,
          sessionTime: now,
        });
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
      debugChatDraft("clearInput:save-empty", {
        storageKey,
        sessionTime: now,
      });
      await adapter.save(
        storageKey,
        { text: "", updatedAt: now, composing: false },
        { ttlMs: CHAT_DRAFT_TTL_MS },
      );
    }
  }, [adapter, localStorageKey, storageKey]);

  const clearComposerDraft = useCallback(
    async (draftKey: number) => {
      const key = `${project_id}:${path}:${draftKey}`;
      const localKey = `chat-composer-draft:${key}`;
      const now = Date.now();
      debugChatDraft("clearComposerDraft:start", {
        storageKey: key,
        localStorageKey: localKey,
        draftKey,
        currentDraftKey: composerDraftKey,
        sessionTime: now,
      });
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
    [adapter, composerDraftKey, path, project_id],
  );

  return { input, setInput, clearInput, clearComposerDraft };
}
