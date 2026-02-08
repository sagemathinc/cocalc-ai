/*
 * Hook for chat composer drafts using the shared draft controller architecture.
 * Draft text is private/account-scoped in AKV and survives refreshes, while
 * syncdb draft records are reserved for lightweight "is composing" presence.
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
    const localText =
      typeof local === "string" ? local : typeof local === "number" ? `${local}` : "";
    const controller = new DraftController({
      key: storageKey,
      adapter,
      debounceMs,
      initialText: localText,
      initialUpdatedAt: 0,
      onError: (err) => console.warn("chat draft controller error", err),
    });
    controllerRef.current = controller;
    const unsub = controller.subscribe((snapshot) => {
      if (!closed) {
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
  }, [localStorageKey]);

  const clearInput = useCallback(async () => {
    delete_local_storage(localStorageKey);
    const controller = controllerRef.current;
    if (!controller) {
      setInputState("");
      return;
    }
    await controller.clear();
  }, [localStorageKey]);

  const clearComposerDraft = useCallback(
    async (draftKey: number) => {
      const key = `${project_id}:${path}:${draftKey}`;
      const localKey = `chat-composer-draft:${key}`;
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
        return;
      }
      await adapter.clear(key);
    },
    [adapter, composerDraftKey, path, project_id],
  );

  return { input, setInput, clearInput, clearComposerDraft };
}
