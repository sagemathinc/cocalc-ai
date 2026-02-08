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
import { webapp_client } from "@cocalc/frontend/webapp-client";

const CHAT_DRAFT_STORE = "chat-composer-drafts-v1";
const CHAT_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
    const controller = new DraftController({
      key: storageKey,
      adapter,
      debounceMs,
      initialText: input,
      initialUpdatedAt: Date.now(),
      ttlMs: CHAT_DRAFT_TTL_MS,
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
  }, [adapter, storageKey, debounceMs]);

  const setInput = useCallback((value: string) => {
    const controller = controllerRef.current;
    if (!controller) {
      setInputState(value);
      return;
    }
    controller.setText(value);
    controller.setComposing(value.trim().length > 0);
  }, []);

  const clearInput = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller) {
      setInputState("");
      return;
    }
    await controller.clear();
  }, []);

  return { input, setInput, clearInput };
}

