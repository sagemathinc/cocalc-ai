/*
 * Hook for chat composer drafts using the shared draft controller architecture.
 * Draft text is private/account-scoped in AKV and survives refreshes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AkvDraftAdapter, DraftController } from "@cocalc/frontend/drafts";
import {
  get_local_storage,
  set_local_storage,
  delete_local_storage,
} from "@cocalc/frontend/misc";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export const CHAT_DRAFT_STORE = "chat-composer-drafts-v1";
export const CHAT_DRAFT_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
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

function storeLocalDraftSnapshot(localStorageKey: string, text: string): void {
  if (text.trim().length === 0 || text.length > MAX_LOCAL_DRAFT_CHARS) {
    delete_local_storage(localStorageKey);
    return;
  }
  set_local_storage(localStorageKey, text);
}

function composerDraftStorageKey({
  project_id,
  path,
  composerDraftKey,
  suffix,
}: {
  project_id: string;
  path: string;
  composerDraftKey: number;
  suffix?: string;
}): string {
  const base = `${project_id}:${path}:${composerDraftKey}`;
  return suffix ? `${base}:${suffix}` : base;
}

function composerDraftLocalStorageKey(storageKey: string): string {
  return `chat-composer-draft:${storageKey}`;
}

export async function writeChatComposerDraft({
  account_id,
  project_id,
  path,
  composerDraftKey,
  text,
  append = false,
  suffix,
}: {
  account_id?: string;
  project_id: string;
  path: string;
  composerDraftKey: number;
  text: string;
  append?: boolean;
  suffix?: string;
}): Promise<string> {
  const storageKey = composerDraftStorageKey({
    project_id,
    path,
    composerDraftKey,
    suffix,
  });
  const localStorageKey = composerDraftLocalStorageKey(storageKey);
  const trimmedText = `${text ?? ""}`.trim();
  if (!trimmedText) return "";

  let existing = "";
  const shadow = shadowDraftState.get(storageKey);
  if (shadow) {
    existing = shadow.text;
  } else {
    const local = get_local_storage(localStorageKey);
    existing =
      typeof local === "string"
        ? local
        : typeof local === "number"
          ? `${local}`
          : "";
  }

  let adapter: AkvDraftAdapter | null = null;
  if (account_id) {
    const cn = webapp_client.conat_client.conat();
    const kv = cn.sync.akv<any>({
      account_id,
      name: CHAT_DRAFT_STORE,
    });
    adapter = new AkvDraftAdapter({
      kv,
      defaultTtlMs: CHAT_DRAFT_TTL_MS,
    });
    if (!existing.trim()) {
      try {
        existing = (await adapter.load(storageKey))?.text ?? "";
      } catch (err) {
        console.warn("chat draft load failed", err);
      }
    }
  }

  const next =
    append && existing.trim()
      ? `${existing.replace(/\s+$/g, "")}\n\n${trimmedText}`
      : trimmedText;
  const now = Date.now();
  setShadow(storageKey, { text: next, updatedAt: now });
  storeLocalDraftSnapshot(localStorageKey, next);
  if (adapter) {
    try {
      await adapter.save(
        storageKey,
        { text: next, updatedAt: now, composing: next.trim().length > 0 },
        { ttlMs: CHAT_DRAFT_TTL_MS },
      );
    } finally {
      adapter.close();
    }
  }
  return next;
}

interface UseChatComposerDraftOptions {
  account_id?: string;
  project_id: string;
  path: string;
  composerDraftKey: number;
  debounceMs?: number;
  suffix?: string;
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
  suffix,
}: UseChatComposerDraftOptions): UseChatComposerDraftResult {
  const [input, setInputState] = useState("");
  const controllerRef = useRef<DraftController | null>(null);
  const pendingLocalWriteRef = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    value: string;
  }>({ value: "" });

  const storageKey = useMemo(
    () =>
      composerDraftStorageKey({
        project_id,
        path,
        composerDraftKey,
        suffix,
      }),
    [project_id, path, composerDraftKey, suffix],
  );
  const localStorageKey = useMemo(
    () => composerDraftLocalStorageKey(storageKey),
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
    if (!adapter) {
      setInputState("");
      return;
    }
    const local = get_local_storage(localStorageKey);
    let localText =
      typeof local === "string"
        ? local
        : typeof local === "number"
          ? `${local}`
          : "";
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
      const snapshot = controller.getSnapshot();
      setShadow(storageKey, {
        text: snapshot.text,
        updatedAt: snapshot.updatedAt,
      });
      storeLocalDraftSnapshot(localStorageKey, snapshot.text);
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      void controller.dispose();
    };
  }, [adapter, storageKey, debounceMs, localStorageKey]);

  useEffect(() => {
    return () => {
      adapter?.close();
    };
  }, [adapter]);

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

  const setInput = useCallback(
    (value: string) => {
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
    },
    [scheduleLocalWrite, storageKey],
  );

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
      const key = composerDraftStorageKey({
        project_id,
        path,
        composerDraftKey: draftKey,
        suffix,
      });
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
    [
      adapter,
      cancelPendingLocalWrite,
      composerDraftKey,
      path,
      project_id,
      suffix,
    ],
  );

  return { input, setInput, clearInput, clearComposerDraft };
}

export function writeChatComposerAcpPromptDraft(
  opts: Omit<Parameters<typeof writeChatComposerDraft>[0], "suffix">,
): Promise<string> {
  return writeChatComposerDraft({ ...opts, suffix: "acp-prompt" });
}

export function useChatComposerAcpPromptDraft(
  opts: Omit<UseChatComposerDraftOptions, "suffix">,
): UseChatComposerDraftResult {
  return useChatComposerDraft({ ...opts, suffix: "acp-prompt" });
}
