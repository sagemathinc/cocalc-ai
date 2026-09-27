/*
 * Account-private composer drafts shared by all views of a conversation.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AkvDraftAdapter, DraftController } from "@cocalc/frontend/drafts";
import {
  get_local_storage,
  set_local_storage,
  delete_local_storage,
} from "@cocalc/frontend/misc";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { getLogger } from "@cocalc/conat/logger";

const logger = getLogger("chat:composer-drafts");

export const CHAT_DRAFT_STORE = "chat-composer-drafts-v1";
export const CHAT_DRAFT_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const MAX_LOCAL_DRAFT_CHARS = 200_000;
const MAX_SHADOW_ENTRIES = 500;
const LOCAL_WRITE_DEBOUNCE_MS = 350;

interface UseChatComposerDraftOptions {
  account_id?: string;
  project_id: string;
  path: string;
  composerDraftKey: number;
  debounceMs?: number;
  suffix?: string;
}

interface UseChatComposerDraftResult {
  ready: boolean;
  input: string;
  setInput: (value: string) => void;
  clearInput: () => Promise<void>;
  clearComposerDraft: (draftKey: number) => Promise<void>;
}

function storageKey(opts: UseChatComposerDraftOptions): string {
  const base = `${opts.project_id}:${opts.path}:${opts.composerDraftKey}`;
  return opts.suffix ? `${base}:${opts.suffix}` : base;
}

function identity(opts: UseChatComposerDraftOptions): string {
  return JSON.stringify([opts.account_id ?? null, storageKey(opts)]);
}

type Shadow = { text: string; updatedAt: number };
const shadows = new Map<string, Shadow>();
const sessions = new Map<string, DraftSession>();

function remember(key: string, snapshot: Shadow) {
  shadows.delete(key);
  shadows.set(key, snapshot);
  if (shadows.size > MAX_SHADOW_ENTRIES) {
    shadows.delete(shadows.keys().next().value!);
  }
}

function readLocal(value: unknown): Shadow | undefined {
  // Older releases saved plain text without a comparable edit timestamp.
  if (typeof value === "string")
    return value.length <= MAX_LOCAL_DRAFT_CHARS
      ? { text: value, updatedAt: 0 }
      : undefined;
  if (value == null || typeof value !== "object") return;
  const snapshot = value as Partial<Shadow> & { version?: unknown };
  if (
    snapshot.version !== 1 ||
    typeof snapshot.text !== "string" ||
    snapshot.text.length > MAX_LOCAL_DRAFT_CHARS ||
    typeof snapshot.updatedAt !== "number" ||
    !Number.isSafeInteger(snapshot.updatedAt) ||
    snapshot.updatedAt < 0
  )
    return;
  return { text: snapshot.text, updatedAt: snapshot.updatedAt };
}

function storeLocal(key: string, { text, updatedAt }: Shadow) {
  if (
    (!text && updatedAt === 0) ||
    !readLocal({ version: 1, text, updatedAt })
  ) {
    delete_local_storage(key);
  } else {
    // Empty snapshots are durable tombstones: deleting the key would let an
    // older remote save resurrect a draft after a send followed by reload.
    set_local_storage(key, { version: 1, text, updatedAt });
  }
}

class DraftSession {
  readonly controller: DraftController;
  readonly ready: Promise<unknown>;
  private readonly adapter: AkvDraftAdapter;
  private refs = 0;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly localKey: string;
  private loadFailed = false;
  private edited = false;
  private readonly onPageHide = () => this.saveLocal();
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "hidden") this.saveLocal();
  };

  constructor(
    private readonly id: string,
    opts: UseChatComposerDraftOptions,
  ) {
    const key = storageKey(opts);
    // Remote keys remain unchanged inside the account-scoped AKV. Migrate the
    // old browser-local snapshot once, so upgrading does not discard a draft
    // whose debounced remote save had not completed.
    this.localKey = `chat-composer-draft:${id}`;
    const stored = get_local_storage(this.localKey);
    let local = readLocal(stored);
    const legacyKey = `chat-composer-draft:${key}`;
    if (stored == null && !shadows.has(id)) {
      local = readLocal(get_local_storage(legacyKey));
      if (local) storeLocal(this.localKey, local);
    }
    delete_local_storage(legacyKey);
    const shadow = shadows.get(id);
    const initial =
      shadow && (!local || shadow.updatedAt >= local.updatedAt)
        ? shadow
        : local;
    this.adapter = new AkvDraftAdapter({
      kv: webapp_client.conat_client.conat().sync.akv<any>({
        account_id: opts.account_id!,
        name: CHAT_DRAFT_STORE,
      }),
      defaultTtlMs: CHAT_DRAFT_TTL_MS,
    });
    this.controller = new DraftController({
      key,
      adapter: {
        load: async (key) => {
          try {
            return await this.adapter.load(key);
          } catch (error) {
            this.loadFailed = true;
            throw error;
          }
        },
        save: async (key, snapshot, options) => {
          // A canceled share must not overwrite an unread remote draft with
          // an empty or stale local snapshot after hydration failed.
          if (this.loadFailed && !this.edited) return;
          await this.adapter.save(key, snapshot, options);
        },
        clear: (key) => this.adapter.clear(key),
      },
      debounceMs: opts.debounceMs,
      initialText: initial?.text ?? "",
      initialUpdatedAt: initial?.updatedAt ?? 0,
      // A local clear/edit must sort after a hydrated snapshot even when both
      // occur in the same millisecond (or the browser clock moved backwards).
      now: () =>
        Math.max(Date.now(), this.controller.getSnapshot().updatedAt + 1),
      onError: (error) => logger.warn("draft persistence failed", error),
    });
    this.controller.subscribe((snapshot) => {
      remember(id, snapshot);
      clearTimeout(this.timer);
      if (!snapshot.text.trim()) this.saveLocal();
      else
        this.timer = setTimeout(
          () => this.saveLocal(),
          LOCAL_WRITE_DEBOUNCE_MS,
        );
    });
    this.ready = this.controller.init();
  }

  retain() {
    if (this.refs++ === 0) {
      // Page lifecycle events do not unmount React or await asynchronous saves.
      // One listener pair per shared session writes the latest snapshot inline.
      if (typeof window !== "undefined")
        window.addEventListener("pagehide", this.onPageHide);
      if (typeof document !== "undefined")
        document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.generation++;
  }

  release() {
    this.refs--;
    if (this.refs) return;
    if (typeof window !== "undefined")
      window.removeEventListener("pagehide", this.onPageHide);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.saveLocal();
    const generation = ++this.generation;
    // Keep the session available during flushing. Rapid remounts, StrictMode,
    // and programmatic writes reuse its serialized persistence chain.
    void this.ready.then(async () => {
      await this.controller.flush();
      if (this.refs || generation !== this.generation) return;
      this.saveLocal();
      void this.controller.dispose();
      this.adapter.close();
      sessions.delete(this.id);
    });
  }

  private saveLocal() {
    clearTimeout(this.timer);
    storeLocal(this.localKey, this.controller.getSnapshot());
  }

  setText(text: string) {
    this.edited = true;
    this.controller.setText(text);
    this.controller.setComposing(!!text.trim());
  }

  async clear() {
    this.edited = true;
    // Persist a tombstone, not a deletion, so a stale remote load cannot
    // resurrect a sent draft. All writes use the controller's ordered chain.
    await this.controller.clear({ persistEmpty: true });
  }

  assertLoaded() {
    if (this.loadFailed)
      throw Error("The destination draft could not be loaded.");
  }
}

function acquire(opts: UseChatComposerDraftOptions): DraftSession | undefined {
  if (!opts.account_id) return;
  const id = identity(opts);
  let session = sessions.get(id);
  if (!session) {
    session = new DraftSession(id, opts);
    sessions.set(id, session);
  }
  session.retain();
  return session;
}

export async function writeChatComposerDraft(
  opts: UseChatComposerDraftOptions & {
    text: string;
    append?: boolean;
    /** Recheck after remote hydration, before modifying the shared draft. */
    isCurrent?: () => boolean;
  },
): Promise<string> {
  const assertCurrent = () => {
    if (opts.isCurrent && !opts.isCurrent())
      throw Error("The draft destination or account changed.");
  };
  assertCurrent();
  const text = `${opts.text ?? ""}`.trim();
  if (!text) return "";
  const session = acquire(opts);
  if (!session) return "";
  try {
    await session.ready;
    assertCurrent();
    if (opts.isCurrent) session.assertLoaded();
    const existing = session.controller.getSnapshot().text;
    const next =
      opts.append && existing.length > 0 ? `${existing}\n\n${text}` : text;
    session.setText(next);
    await session.controller.flush();
    return next;
  } finally {
    session.release();
  }
}

export function useChatComposerDraft(
  opts: UseChatComposerDraftOptions,
): UseChatComposerDraftResult {
  const { account_id, project_id, path, composerDraftKey, suffix, debounceMs } =
    opts;
  const id = identity(opts);
  const [state, setState] = useState({ id, input: "", ready: false });
  const current = useRef<{ id: string; session: DraftSession } | undefined>(
    undefined,
  );
  useEffect(() => {
    const session = acquire({
      account_id,
      project_id,
      path,
      composerDraftKey,
      suffix,
      debounceMs,
    });
    if (!session) {
      setState({ id, input: "", ready: false });
      return;
    }
    current.current = { id, session };
    let closed = false;
    setState({
      id,
      input: session.controller.getSnapshot().text,
      ready: false,
    });
    const unsubscribe = session.controller.subscribe(({ text }) => {
      setState((old) => ({
        id,
        input: text,
        ready: old.id === id && old.ready,
      }));
    });
    void session.ready.then(() => {
      if (!closed)
        setState({
          id,
          input: session.controller.getSnapshot().text,
          ready: true,
        });
    });
    return () => {
      closed = true;
      unsubscribe();
      current.current = undefined;
      session.release();
    };
  }, [id, account_id, project_id, path, composerDraftKey, suffix, debounceMs]);

  const setInput = useCallback(
    (text: string) => {
      if (current.current?.id === id) current.current.session.setText(text);
    },
    [id],
  );
  const clearComposerDraft = useCallback(
    async (draftKey: number) => {
      const session = acquire({
        account_id,
        project_id,
        path,
        composerDraftKey: draftKey,
        suffix,
      });
      if (!session) return;
      try {
        // Clear immediately, even if an initial remote read is still pending.
        await session.clear();
      } finally {
        session.release();
      }
    },
    [account_id, project_id, path, suffix],
  );
  const clearInput = useCallback(
    () => clearComposerDraft(composerDraftKey),
    [clearComposerDraft, composerDraftKey],
  );
  return {
    input: state.id === id ? state.input : "",
    ready: state.id === id && state.ready,
    setInput,
    clearInput,
    clearComposerDraft,
  };
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
