/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Browser cache of the signed-in account's agent payment selections. The
// server (account home bay) is the only source of truth, so a choice made on
// one device is what every other device shows and what every turn uses.
// Nothing about how a turn is paid is persisted in this browser.
//
// Reads are synchronous against the cache and schedule a load on a miss; a
// change event fires when data arrives, so existing listeners re-render.
// The cache is refreshed when the window regains focus.

import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  type AgentPaymentDefaults,
  type AgentPaymentProvider,
  type AgentPaymentSelection,
  type AgentPaymentTarget,
  type ClaudePaymentSelection,
  type CodexPaymentSelection,
} from "@cocalc/util/ai/agent-payment-selection";

export const PAYMENT_SELECTION_EVENT = "cocalc:agent-payment-selection";

type Entry = {
  codex?: CodexPaymentSelection;
  "claude-code"?: ClaudePaymentSelection;
};

type Api = {
  getPaymentSelections(opts: {
    targets: AgentPaymentTarget[];
    touch?: boolean;
  }): Promise<{
    selections: Array<{
      project_id: string;
      thread_id: string;
      selection: AgentPaymentSelection;
    }>;
    defaults: AgentPaymentDefaults;
  }>;
  setPaymentSelections(opts: {
    targets?: Array<AgentPaymentTarget & { title?: string }>;
    defaults?: AgentPaymentProvider[];
    selection: AgentPaymentSelection | null;
    provider?: AgentPaymentProvider;
    only_if_absent?: boolean;
  }): Promise<{ updated: number }>;
  copyPaymentSelection(opts: {
    from: AgentPaymentTarget;
    to: AgentPaymentTarget;
  }): Promise<{ copied: boolean }>;
};

let apiOverride: Api | undefined;
function api(): Api | undefined {
  const client = apiOverride ?? (webapp_client.conat_client?.hub?.agent as any);
  return typeof client?.getPaymentSelections === "function"
    ? client
    : undefined;
}

/** Tests only. */
export function resetPaymentSelectionStoreForTests(next?: Api) {
  apiOverride = next;
  entries.clear();
  loaded.clear();
  drafts.clear();
  defaults = {};
  defaultsLoaded = false;
  queue.clear();
  writes.clear();
  account = undefined;
}

/** Tests only: an in-memory stand-in for the account's server records. */
export function createMemoryPaymentApiForTests(): Api & {
  rows: Map<string, AgentPaymentSelection>;
} {
  const rows = new Map<string, AgentPaymentSelection>();
  const thread = (t: AgentPaymentTarget) =>
    `thread:${t.project_id}:${t.thread_id}`;
  const result = (targets: AgentPaymentTarget[]) => {
    const defaults: AgentPaymentDefaults = {};
    for (const [k, v] of rows)
      if (k.startsWith("default:")) (defaults as any)[v.provider] = v;
    return {
      selections: targets.flatMap((t) => {
        const prefix = thread(t);
        return [...rows]
          .filter(([k]) => k.startsWith(`${prefix}:`))
          .map(([, selection]) => ({ ...t, selection }));
      }),
      defaults,
    };
  };
  return {
    rows,
    async getPaymentSelections({ targets }) {
      return result(targets);
    },
    async setPaymentSelections({
      targets = [],
      defaults = [],
      selection,
      provider,
      only_if_absent,
    }) {
      let updated = 0;
      const keys = [
        ...targets.map((t) => (p: string) => `${thread(t)}:${p}`),
        ...defaults.map((d) => (p: string) => (p === d ? `default:${d}` : "")),
      ];
      for (const make of keys) {
        for (const p of ["codex", "claude-code"]) {
          const k = make(p);
          if (!k) continue;
          if (selection === null) {
            if (provider && provider !== p) continue;
            if (rows.delete(k)) updated++;
          } else if (selection.provider === p) {
            if (only_if_absent && rows.has(k)) continue;
            rows.set(k, selection);
            updated++;
          }
        }
      }
      return { updated };
    },
    async copyPaymentSelection({ from, to }) {
      let copied = false;
      for (const p of ["codex", "claude-code"]) {
        const v = rows.get(`${thread(from)}:${p}`);
        if (v && !rows.has(`${thread(to)}:${p}`)) {
          rows.set(`${thread(to)}:${p}`, v);
          copied = true;
        }
      }
      return { copied };
    },
  };
}

/** Tests only: put a selection in the cache as if loaded from the server. */
export function seedPaymentSelectionForTests(opts: {
  accountId: string;
  projectId: string;
  threadKey: string;
  selection?: AgentPaymentSelection;
  defaults?: AgentPaymentDefaults;
}) {
  forAccount(opts.accountId);
  const k = key(opts.projectId, opts.threadKey);
  const entry = { ...(entries.get(k) ?? {}) };
  if (opts.selection) (entry as any)[opts.selection.provider] = opts.selection;
  entries.set(k, entry);
  loaded.add(k);
  if (opts.defaults) {
    defaults = { ...defaults, ...opts.defaults };
  }
  defaultsLoaded = true;
}

let account: string | undefined;
const entries = new Map<string, Entry>();
const loaded = new Set<string>();
// Conversations not created yet ("new" thread) live only in memory until the
// thread exists and the choice is saved under its id.
const drafts = new Map<string, Entry>();
let defaults: AgentPaymentDefaults = {};
let defaultsLoaded = false;
const queue = new Map<string, AgentPaymentTarget>();
// Local changes since a load started win over that load's (older) result.
const writes = new Map<string, number>();
let writeSeq = 0;
let flushing: Promise<void> | undefined;

const key = (project_id: string, thread_id: string) =>
  `${project_id}:${thread_id}`;

function isDraft(threadKey?: string) {
  return !threadKey || threadKey === "new";
}

function emit() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(PAYMENT_SELECTION_EVENT));
}

// Selections belong to one account; a different signed-in account starts empty.
function forAccount(accountId?: string): boolean {
  if (!accountId) return false;
  if (account !== accountId) {
    account = accountId;
    entries.clear();
    loaded.clear();
    drafts.clear();
    defaults = {};
    defaultsLoaded = false;
    void migrateLocalStorage(accountId);
  }
  return true;
}

const CODEX_PREFIX = "cocalc:codex-subscription:v1";
const CLAUDE_PREFIX = "cocalc:acp-harness-credential:v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function claudeFromStored(
  value: string,
  connectorsOff: boolean,
): ClaudePaymentSelection | undefined {
  if (value === "project-secret")
    return { version: 1, provider: "claude-code", mode: "project-secret" };
  for (const mode of ["account-api-key", "account-subscription"] as const) {
    const id = value.startsWith(`${mode}:`) ? value.slice(mode.length + 1) : "";
    if (!UUID.test(id)) continue;
    return mode === "account-subscription"
      ? {
          version: 1,
          provider: "claude-code",
          mode,
          credential_id: id,
          ...(connectorsOff ? { claude_ai_connectors: false as const } : {}),
        }
      : { version: 1, provider: "claude-code", mode, credential_id: id };
  }
}

// Earlier versions kept these choices in each browser. Upload this browser's
// choices once, never overwriting what the server already has (another
// device's later choice wins), then forget them locally.
export async function migrateLocalStorage(accountId: string): Promise<void> {
  if (typeof localStorage === "undefined") return;
  const client = api();
  if (!client) return;
  const groups = new Map<
    string,
    {
      selection: AgentPaymentSelection;
      targets: AgentPaymentTarget[];
      defaults: AgentPaymentProvider[];
      keys: string[];
    }
  >();
  const add = (
    selection: AgentPaymentSelection,
    storageKeys: string[],
    target?: AgentPaymentTarget,
  ) => {
    const id = JSON.stringify(selection);
    const group = groups.get(id) ?? {
      selection,
      targets: [],
      defaults: [],
      keys: [],
    };
    if (target) group.targets.push(target);
    else group.defaults.push(selection.provider);
    group.keys.push(...storageKeys);
    groups.set(id, group);
  };
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const storageKey = localStorage.key(i);
    if (!storageKey) continue;
    for (const prefix of [CODEX_PREFIX, CLAUDE_PREFIX]) {
      const head = `${prefix}:${accountId}:`;
      if (!storageKey.startsWith(head)) continue;
      const rest = storageKey.slice(head.length);
      if (rest.endsWith(":claude-ai-connectors")) continue;
      const value = localStorage.getItem(storageKey) ?? "";
      if (prefix === CLAUDE_PREFIX && rest === "default") {
        const selection = claudeFromStored(
          value,
          localStorage.getItem(`${storageKey}:claude-ai-connectors`) === "off",
        );
        if (selection && selection.mode !== "project-secret")
          add(selection, [storageKey, `${storageKey}:claude-ai-connectors`]);
        else stale.push(storageKey);
        continue;
      }
      const colon = rest.indexOf(":");
      const project_id = rest.slice(0, colon);
      const thread_id = rest.slice(colon + 1);
      if (colon < 0 || !UUID.test(project_id) || isDraft(thread_id)) {
        stale.push(storageKey);
        continue;
      }
      const selection: AgentPaymentSelection | undefined =
        prefix === CODEX_PREFIX
          ? UUID.test(value)
            ? {
                version: 1,
                provider: "codex",
                mode: "credential",
                credential_id: value,
              }
            : undefined
          : claudeFromStored(
              value,
              localStorage.getItem(`${storageKey}:claude-ai-connectors`) ===
                "off",
            );
      if (!selection) stale.push(storageKey);
      else
        add(selection, [storageKey, `${storageKey}:claude-ai-connectors`], {
          project_id,
          thread_id,
        });
    }
  }
  for (const group of groups.values()) {
    try {
      for (let i = 0; i < group.targets.length || i === 0; i += 500) {
        const targets = group.targets.slice(i, i + 500);
        const defaultsNow = i === 0 ? group.defaults : [];
        if (targets.length === 0 && defaultsNow.length === 0) break;
        await client.setPaymentSelections({
          targets,
          defaults: defaultsNow,
          selection: group.selection,
          only_if_absent: true,
        });
      }
      stale.push(...group.keys);
    } catch (err) {
      // Keep the local copy; the next load retries.
      console.warn("could not migrate agent payment selections", err);
    }
  }
  for (const storageKey of stale) localStorage.removeItem(storageKey);
  if (groups.size > 0) refreshPaymentSelections();
}

function apply(
  result: Awaited<ReturnType<Api["getPaymentSelections"]>>,
  targets: AgentPaymentTarget[],
  startedAt: number,
) {
  const fresh = (k: string) => (writes.get(k) ?? 0) <= startedAt;
  const next = new Map<string, Entry>();
  for (const target of targets)
    next.set(key(target.project_id, target.thread_id), {});
  for (const record of result.selections) {
    const k = key(record.project_id, record.thread_id);
    const entry = next.get(k) ?? {};
    (entry as any)[record.selection.provider] = record.selection;
    next.set(k, entry);
  }
  for (const [k, entry] of next) {
    if (!fresh(k)) continue;
    entries.set(k, entry);
    loaded.add(k);
  }
  if (fresh("defaults")) defaults = result.defaults ?? {};
  defaultsLoaded = true;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  const targets = [...queue.values()];
  queue.clear();
  const client = api();
  if (!client || targets.length === 0) return;
  const startedAt = writeSeq;
  try {
    apply(await client.getPaymentSelections({ targets }), targets, startedAt);
    emit();
  } catch (err) {
    console.warn("could not load agent payment selections", err);
  }
}

function schedule(target?: AgentPaymentTarget) {
  if (target) queue.set(key(target.project_id, target.thread_id), target);
  flushing ??= flush().finally(() => {
    flushing = undefined;
    if (queue.size > 0) schedule();
  });
}

function entryFor(
  accountId: string | undefined,
  projectId: string | undefined,
  threadKey: string | undefined,
): Entry | undefined {
  if (!forAccount(accountId) || !projectId) return;
  if (isDraft(threadKey)) return drafts.get(projectId);
  const k = key(projectId, threadKey!);
  if (!loaded.has(k))
    schedule({ project_id: projectId, thread_id: threadKey! });
  return entries.get(k);
}

export function readPaymentSelection(opts: {
  accountId?: string;
  projectId?: string;
  threadKey?: string;
  provider: AgentPaymentProvider;
}): AgentPaymentSelection | undefined {
  return entryFor(opts.accountId, opts.projectId, opts.threadKey)?.[
    opts.provider
  ];
}

export function readPaymentDefault(opts: {
  accountId?: string;
  provider: AgentPaymentProvider;
}): AgentPaymentSelection | undefined {
  if (!forAccount(opts.accountId)) return;
  if (!defaultsLoaded && queue.size === 0) {
    // Any lookup returns the defaults; ask with no targets via an empty batch.
    void (async () => {
      const client = api();
      if (!client || defaultsLoaded) return;
      const startedAt = writeSeq;
      try {
        apply(
          await client.getPaymentSelections({ targets: [] }),
          [],
          startedAt,
        );
        emit();
      } catch {}
    })();
  }
  return defaults[opts.provider];
}

export function isPaymentSelectionLoaded(opts: {
  accountId?: string;
  projectId?: string;
  threadKey?: string;
}): boolean {
  if (!forAccount(opts.accountId) || !opts.projectId) return false;
  return (
    isDraft(opts.threadKey) || loaded.has(key(opts.projectId, opts.threadKey!))
  );
}

/** Set (or clear with null) the choice for one conversation. */
export function writePaymentSelection(opts: {
  accountId?: string;
  projectId: string;
  threadKey?: string;
  provider: AgentPaymentProvider;
  selection: AgentPaymentSelection | null;
  path?: string;
  title?: string;
}): Promise<void> {
  if (!forAccount(opts.accountId)) return Promise.resolve();
  const draft = isDraft(opts.threadKey);
  const map = draft ? drafts : entries;
  const k = draft ? opts.projectId : key(opts.projectId, opts.threadKey!);
  const entry = { ...(map.get(k) ?? {}) };
  if (opts.selection) (entry as any)[opts.provider] = opts.selection;
  else delete entry[opts.provider];
  map.set(k, entry);
  if (!draft) {
    loaded.add(k);
    writes.set(k, ++writeSeq);
  }
  emit();
  if (draft) return Promise.resolve();
  const client = api();
  if (!client) return Promise.resolve();
  return client
    .setPaymentSelections({
      targets: [
        {
          project_id: opts.projectId,
          thread_id: opts.threadKey!,
          ...(opts.path ? { path: opts.path } : {}),
          ...(opts.title ? { title: opts.title } : {}),
        },
      ],
      selection: opts.selection,
      provider: opts.provider,
    })
    .then(
      () => {},
      (err) => {
        // Show the server's state again rather than a choice it never saved.
        loaded.delete(k);
        console.warn("could not save agent payment selection", err);
        emit();
      },
    );
}

export async function setPaymentDefault(opts: {
  accountId?: string;
  provider: AgentPaymentProvider;
  selection: AgentPaymentSelection | null;
  /** Only set it if the account has no default yet. */
  onlyIfAbsent?: boolean;
}): Promise<void> {
  if (!forAccount(opts.accountId)) return;
  if (opts.onlyIfAbsent && defaults[opts.provider]) return;
  writes.set("defaults", ++writeSeq);
  if (opts.selection) (defaults as any)[opts.provider] = opts.selection;
  else delete defaults[opts.provider];
  emit();
  try {
    await api()?.setPaymentSelections({
      defaults: [opts.provider],
      selection: opts.selection,
      provider: opts.provider,
      only_if_absent: opts.onlyIfAbsent,
    });
  } catch (err) {
    defaultsLoaded = false;
    console.warn("could not save agent payment default", err);
  } finally {
    // Another device may already have set it; show the server's value.
    if (opts.onlyIfAbsent) defaultsLoaded = false;
  }
}

/** Keep the choice when a conversation is forked, copied or started fresh. */
export async function copyPaymentSelection(opts: {
  accountId?: string;
  from: AgentPaymentTarget;
  to: AgentPaymentTarget;
}): Promise<void> {
  if (!forAccount(opts.accountId)) return;
  const source = entries.get(key(opts.from.project_id, opts.from.thread_id));
  const k = key(opts.to.project_id, opts.to.thread_id);
  if (source) {
    entries.set(k, { ...source });
    loaded.add(k);
    writes.set(k, ++writeSeq);
    emit();
  } else loaded.delete(k);
  try {
    await api()?.copyPaymentSelection({ from: opts.from, to: opts.to });
  } catch (err) {
    console.warn("could not copy agent payment selection", err);
  }
}

/** Fresh server read for one conversation, used right before a send. */
export async function fetchPaymentSelectionForSend(opts: {
  accountId?: string;
  projectId?: string;
  threadKey?: string;
}): Promise<void> {
  if (!forAccount(opts.accountId) || !opts.projectId || isDraft(opts.threadKey))
    return;
  const client = api();
  if (!client) return;
  const target = { project_id: opts.projectId, thread_id: opts.threadKey! };
  const startedAt = writeSeq;
  try {
    apply(
      await client.getPaymentSelections({ targets: [target], touch: true }),
      [target],
      startedAt,
    );
    emit();
  } catch (err) {
    // Fall back to the cached choice; the host revalidates at admission.
    console.warn("could not refresh agent payment selection", err);
  }
}

/** Re-read everything cached, e.g. after another device changed it. */
export function refreshPaymentSelections(): void {
  for (const k of loaded) {
    const [project_id, ...rest] = k.split(":");
    schedule({ project_id, thread_id: rest.join(":") });
  }
  loaded.clear();
  defaultsLoaded = false;
}

if (typeof window !== "undefined") {
  const refresh = () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    )
      return;
    refreshPaymentSelections();
  };
  window.addEventListener("focus", refresh);
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", refresh);
}
