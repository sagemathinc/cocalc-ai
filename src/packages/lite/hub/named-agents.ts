/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Named agents in CoCalc Plus: the subset of the hub's agent API that the Agents
page (/agents) and the CLI use, for the one account and the one project of a
local installation, kept in Lite's SQLite database.

- An agent identity is a chat thread (project, path, thread) with a stable
  agent_id; starting a fresh conversation moves it to a new thread and keeps
  the old one in its history (as on cocalc.ai, server/agents/api.ts).
- A name is the account's name for an identity (server/agents/personal-store.ts):
  normalized, unique per account, one active name per identity.
- Payment selections are stored as they are set, so every surface reads the
  same choice; in CoCalc Plus they only ever name the user's own credentials.

What cocalc.ai spreads over bays, hosts and runs (routing, rehoming, agent run
tokens, watchers) has no counterpart here.
*/

import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import type {
  NameAgentOptions,
  NamedAgent,
  NamedAgentDirectory,
  RetireNamedAgentOptions,
} from "@cocalc/conat/agents/personal";
import { normalizeAgentName } from "@cocalc/conat/agents/personal";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import type { SetAgentPaymentSelectionsRequest } from "@cocalc/conat/inter-bay/agent-payment-selections";
import {
  agentPaymentDefaultKey,
  agentPaymentTargetKey,
  parseAgentPaymentSelection,
  type AgentPaymentDefaults,
  type AgentPaymentProvider,
  type AgentPaymentSelectionRecord,
  type AgentPaymentTarget,
} from "@cocalc/util/ai/agent-payment-selection";
import {
  agentRuntimeFromThread,
  parseAgentRuntimeSummary,
  type AgentRuntimeSummary,
} from "@cocalc/util/ai/agent-runtime-kind";
import { isValidUUID } from "@cocalc/util/misc";
import { getDatabase, type SqliteDatabase } from "./sqlite/database";

/** As on cocalc.ai: names are a small personal directory. */
export const MAX_NAMED_AGENTS = 200;
const MAX_IDENTITIES = 10_000;
const MAX_HISTORY = 1000;

/** The chat thread's configuration, or undefined if it has none. */
export type ThreadReader = (opts: {
  project_id: string;
  path: string;
  thread_id: string;
}) => Promise<Record<string, any> | undefined>;

/** Asks the ACP runner for a fresh conversation's thread (the old thread
 * stops admitting turns); returns its id. */
export type FreshThreadPreparer = (opts: {
  account_id: string;
  project_id: string;
  path: string;
  thread_id: string;
}) => Promise<string>;

export interface NamedAgentsContext {
  account_id: string;
  project_id: string;
  db?: () => SqliteDatabase;
  readThread: ThreadReader;
  prepareFreshThread: FreshThreadPreparer;
  now?: () => Date;
}

type IdentityRow = {
  agent_id: string;
  project_id: string;
  path: string;
  thread_id: string;
  name: string;
  created_by: string;
  conversation_history: string | null;
  disabled_at: string | null;
  appearance: string | null;
  runtime: string | null;
  created_at: string;
};

type NameRow = {
  account_id: string;
  name: string;
  project_id: string;
  agent_id: string;
  metadata: string;
  created_at: string;
  updated_at: string;
};

const initialized = new WeakSet<object>();

function ensureTables(db: SqliteDatabase): void {
  if (initialized.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS lite_agent_identities (
      agent_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      conversation_history TEXT,
      disabled_at TEXT,
      appearance TEXT,
      runtime TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS lite_agent_identities_thread
      ON lite_agent_identities(project_id, path, thread_id)
      WHERE disabled_at IS NULL;
    CREATE TABLE IF NOT EXISTS lite_agent_names (
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, name)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS lite_agent_names_endpoint
      ON lite_agent_names(account_id, project_id, agent_id);
    CREATE TABLE IF NOT EXISTS lite_agent_payment_selections (
      account_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      project_id TEXT,
      path TEXT,
      thread_id TEXT,
      selection TEXT NOT NULL,
      title TEXT,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      PRIMARY KEY (account_id, target_key, provider)
    );
  `);
  initialized.add(db);
}

function json<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/** A chat path, as cocalc.ai stores it: normalized, and only .chat files. */
export function normalizeAgentChatPath(path: unknown): string {
  if (
    typeof path !== "string" ||
    !path.trim() ||
    path.includes("\0") ||
    path.length > 4096
  )
    throw new Error("invalid chat path");
  const normalized = posix.normalize(path);
  if (!normalized.endsWith(".chat"))
    throw new Error("agent requires a .chat path");
  return normalized;
}

function threadId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200)
    throw new Error("invalid thread_id");
  return value;
}

export function createNamedAgents(ctx: NamedAgentsContext) {
  const now = () => (ctx.now?.() ?? new Date()).toISOString();
  const db = () => {
    const handle = (ctx.db ?? getDatabase)();
    ensureTables(handle);
    return handle;
  };

  // One account and one project: anything else is not this installation's.
  function account(value?: string): string {
    const account_id = `${value ?? ctx.account_id}`.trim() || ctx.account_id;
    if (account_id !== ctx.account_id)
      throw new Error("only the local account has agents here");
    return account_id;
  }
  function project(value: unknown): string {
    if (typeof value !== "string" || !isValidUUID(value))
      throw new Error("invalid project_id");
    if (value !== ctx.project_id)
      throw new Error(`project '${value}' is not available in CoCalc Plus`);
    return value;
  }

  function toIdentity(row: IdentityRow): AgentIdentity {
    return {
      agent_id: row.agent_id,
      project_id: row.project_id,
      path: row.path,
      thread_id: row.thread_id,
      name: row.name,
      created_by: row.created_by,
      conversation_history: json(row.conversation_history) ?? [],
      disabled_at: row.disabled_at,
      appearance: json(row.appearance) ?? null,
      runtime: parseAgentRuntimeSummary(json(row.runtime)) ?? null,
    };
  }

  function identityById(agent_id: string): IdentityRow | undefined {
    return db()
      .prepare("SELECT * FROM lite_agent_identities WHERE agent_id=?")
      .get(agent_id) as IdentityRow | undefined;
  }

  function activeIdentity(
    project_id: string,
    path: string,
    thread_id: string,
  ): IdentityRow | undefined {
    return db()
      .prepare(
        "SELECT * FROM lite_agent_identities WHERE project_id=? AND path=? AND thread_id=? AND disabled_at IS NULL",
      )
      .get(project_id, path, thread_id) as IdentityRow | undefined;
  }

  function appearanceOf(thread: Record<string, any>) {
    const appearance: Record<string, string> = {};
    for (const key of ["color", "icon", "image"] as const)
      if (typeof thread[key] === "string" && thread[key])
        appearance[key] = thread[key];
    return Object.keys(appearance).length ? appearance : null;
  }

  async function registerIdentity(opts: {
    account_id?: string;
    project_id: string;
    path: string;
    thread_id: string;
  }): Promise<AgentIdentity> {
    const account_id = account(opts.account_id);
    const project_id = project(opts.project_id);
    const thread_id = threadId(opts.thread_id);
    const path = normalizeAgentChatPath(opts.path);
    const thread = await ctx.readThread({ project_id, path, thread_id });
    if (!thread || thread.agent_kind !== "acp" || thread.archived)
      throw new Error("an existing non-archived agent thread is required");
    const runtime: AgentRuntimeSummary | undefined =
      agentRuntimeFromThread(thread);
    const existing = activeIdentity(project_id, path, thread_id);
    if (existing) {
      // Identities from before the runtime (or its model) was known.
      const known = parseAgentRuntimeSummary(json(existing.runtime));
      if (
        runtime &&
        (!known ||
          (!known.model &&
            runtime.model &&
            known.kind === runtime.kind &&
            known.name === runtime.name))
      ) {
        db()
          .prepare(
            "UPDATE lite_agent_identities SET runtime=? WHERE agent_id=?",
          )
          .run(JSON.stringify(runtime), existing.agent_id);
        return toIdentity(identityById(existing.agent_id)!);
      }
      return toIdentity(existing);
    }
    const count = (
      db().prepare("SELECT count(*) AS n FROM lite_agent_identities").get() as {
        n: number;
      }
    ).n;
    if (count >= MAX_IDENTITIES)
      throw new Error("agent_identity_project_capacity");
    const agent_id = randomUUID();
    db()
      .prepare(
        `INSERT INTO lite_agent_identities
           (agent_id, project_id, path, thread_id, name, created_by,
            conversation_history, appearance, runtime, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
      )
      .run(
        agent_id,
        project_id,
        path,
        thread_id,
        `${thread.name || thread_id}`.slice(0, 200),
        account_id,
        JSON.stringify(appearanceOf(thread)),
        runtime ? JSON.stringify(runtime) : null,
        now(),
      );
    return toIdentity(identityById(agent_id)!);
  }

  async function getIdentity(opts: {
    account_id?: string;
    agent_id: string;
    project_id?: string;
  }): Promise<AgentIdentity> {
    account(opts.account_id);
    if (!isValidUUID(opts.agent_id)) throw new Error("invalid agent_id");
    const row = identityById(opts.agent_id);
    if (!row) throw new Error("agent not found");
    if (opts.project_id !== undefined && opts.project_id !== row.project_id)
      throw new Error(
        "agent identity does not belong to the requested project",
      );
    return toIdentity(row);
  }

  async function resolveIdentity(opts: {
    account_id?: string;
    project_id: string;
    path: string;
    thread_id: string;
  }): Promise<AgentIdentity | undefined> {
    account(opts.account_id);
    const project_id = project(opts.project_id);
    let path: string;
    try {
      path = normalizeAgentChatPath(opts.path);
    } catch {
      // A virtual (non-chat) path is never a registered agent.
      return undefined;
    }
    const row = activeIdentity(project_id, path, threadId(opts.thread_id));
    return row ? toIdentity(row) : undefined;
  }

  async function startFreshConversation(opts: {
    account_id?: string;
    project_id: string;
    agent_id: string;
    expected_thread_id: string;
  }): Promise<AgentIdentity> {
    const account_id = account(opts.account_id);
    const project_id = project(opts.project_id);
    if (!isValidUUID(opts.agent_id)) throw new Error("invalid agent_id");
    const expected = threadId(opts.expected_thread_id);
    const previous = identityById(opts.agent_id);
    if (
      !previous ||
      previous.project_id !== project_id ||
      previous.created_by !== account_id ||
      previous.disabled_at
    )
      throw new Error(
        "Only the active agent's registrant can start a fresh conversation",
      );
    const history =
      json<{ thread_id: string; ended_at: string }[]>(
        previous.conversation_history,
      ) ?? [];
    if (previous.thread_id !== expected) {
      // A retry after the move: the same result.
      if (history.some((entry) => entry.thread_id === expected))
        return toIdentity(previous);
      throw new Error(
        "The agent conversation changed; refresh before starting fresh",
      );
    }
    if (history.length >= MAX_HISTORY)
      throw new Error("Agent conversation history capacity reached");
    const successor = await ctx.prepareFreshThread({
      account_id,
      project_id,
      path: previous.path,
      thread_id: previous.thread_id,
    });
    threadId(successor);
    const current = identityById(opts.agent_id)!;
    // Another call finished the move meanwhile.
    if (current.thread_id !== previous.thread_id) return toIdentity(current);
    db()
      .prepare(
        "UPDATE lite_agent_identities SET thread_id=?, conversation_history=? WHERE agent_id=? AND thread_id=?",
      )
      .run(
        successor,
        JSON.stringify([
          ...history,
          { thread_id: previous.thread_id, ended_at: now() },
        ]),
        opts.agent_id,
        previous.thread_id,
      );
    // A name follows its agent to the new conversation.
    refreshNameSnapshots(opts.agent_id);
    // How it is paid carries over, as on cocalc.ai.
    copyPaymentSelection({
      from: { project_id, thread_id: previous.thread_id, path: previous.path },
      to: { project_id, thread_id: successor, path: previous.path },
    });
    return toIdentity(identityById(opts.agent_id)!);
  }

  // --- names ---

  function snapshot(row: IdentityRow) {
    return {
      path: row.path,
      thread_id: row.thread_id,
      appearance: json(row.appearance) ?? null,
      runtime: parseAgentRuntimeSummary(json(row.runtime)) ?? null,
      available: !row.disabled_at,
    };
  }

  function refreshNameSnapshots(agent_id: string): void {
    const identity = identityById(agent_id);
    if (!identity) return;
    const rows = db()
      .prepare("SELECT * FROM lite_agent_names WHERE agent_id=?")
      .all(agent_id) as NameRow[];
    for (const row of rows) {
      const metadata = {
        ...(json<any>(row.metadata) ?? {}),
        ...snapshot(identity),
      };
      db()
        .prepare(
          "UPDATE lite_agent_names SET metadata=?, updated_at=? WHERE account_id=? AND name=?",
        )
        .run(JSON.stringify(metadata), now(), row.account_id, row.name);
    }
  }

  function named(row: NameRow): NamedAgent {
    const metadata = json<any>(row.metadata) ?? {};
    // The identity is local: always current, never a stale snapshot.
    const identity = identityById(row.agent_id);
    const current = identity ? snapshot(identity) : undefined;
    return {
      account_id: row.account_id,
      name: row.name,
      endpoint: { project_id: row.project_id, agent_id: row.agent_id },
      path: current?.path ?? metadata.path ?? "",
      thread_id: current?.thread_id ?? metadata.thread_id ?? "",
      ...(metadata.project_title
        ? { project_title: metadata.project_title }
        : {}),
      ...(metadata.thread_title ? { thread_title: metadata.thread_title } : {}),
      ...(metadata.description ? { description: metadata.description } : {}),
      available: current?.available ?? false,
      updated_at: row.updated_at,
      ...(current?.appearance ? { appearance: current.appearance } : {}),
      ...(current?.runtime ? { runtime: current.runtime } : {}),
    };
  }

  function endpointIdentity(endpoint: AgentEndpoint): IdentityRow {
    if (
      !endpoint ||
      typeof endpoint !== "object" ||
      !isValidUUID(endpoint.agent_id)
    )
      throw new Error("invalid agent endpoint");
    project(endpoint.project_id);
    const row = identityById(endpoint.agent_id);
    if (!row || row.project_id !== endpoint.project_id)
      throw new Error("agent not found");
    if (row.disabled_at) throw new Error("agent is disabled");
    return row;
  }

  async function nameAgent(
    opts: { account_id?: string } & NameAgentOptions,
  ): Promise<NamedAgent> {
    const account_id = account(opts.account_id);
    const name = normalizeAgentName(opts.name);
    const identity = endpointIdentity(opts.endpoint);
    for (const key of ["description", "project_title", "thread_title"] as const)
      if (
        opts[key] !== undefined &&
        (typeof opts[key] !== "string" || opts[key]!.length > 500)
      )
        throw new Error(`invalid ${key}`);
    const previous = db()
      .prepare("SELECT * FROM lite_agent_names WHERE account_id=? AND name=?")
      .get(account_id, name) as NameRow | undefined;
    if (
      previous &&
      (previous.project_id !== identity.project_id ||
        previous.agent_id !== identity.agent_id)
    )
      throw new Error("name_reserved");
    const current = db()
      .prepare(
        "SELECT * FROM lite_agent_names WHERE account_id=? AND project_id=? AND agent_id=?",
      )
      .get(account_id, identity.project_id, identity.agent_id) as
      | NameRow
      | undefined;
    if (!current) {
      const active = (
        db()
          .prepare(
            "SELECT count(*) AS n FROM lite_agent_names WHERE account_id=?",
          )
          .get(account_id) as { n: number }
      ).n;
      if (active >= MAX_NAMED_AGENTS)
        throw new Error(
          `named_agent_limit_reached:${active}:${MAX_NAMED_AGENTS}`,
        );
    }
    const metadata = JSON.stringify({
      ...snapshot(identity),
      description: opts.description,
      project_title: opts.project_title,
      thread_title: opts.thread_title,
    });
    const at = now();
    // Renaming: one name per agent.
    if (current && current.name !== name)
      db()
        .prepare("DELETE FROM lite_agent_names WHERE account_id=? AND name=?")
        .run(account_id, current.name);
    db()
      .prepare(
        `INSERT INTO lite_agent_names
           (account_id, name, project_id, agent_id, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, name) DO UPDATE SET
           metadata=excluded.metadata, updated_at=excluded.updated_at`,
      )
      .run(
        account_id,
        name,
        identity.project_id,
        identity.agent_id,
        metadata,
        current?.created_at ?? at,
        at,
      );
    return named(
      db()
        .prepare("SELECT * FROM lite_agent_names WHERE account_id=? AND name=?")
        .get(account_id, name) as NameRow,
    );
  }

  async function retireNamedAgent(
    opts: { account_id?: string } & RetireNamedAgentOptions,
  ): Promise<void> {
    const account_id = account(opts.account_id);
    const endpoint = opts.endpoint;
    if (!endpoint || !isValidUUID(endpoint.agent_id))
      throw new Error("invalid agent endpoint");
    db()
      .prepare(
        "DELETE FROM lite_agent_names WHERE account_id=? AND project_id=? AND agent_id=?",
      )
      .run(account_id, endpoint.project_id, endpoint.agent_id);
  }

  async function listNamedAgents(opts: {
    account_id?: string;
  }): Promise<NamedAgentDirectory> {
    const account_id = account(opts.account_id);
    const rows = db()
      .prepare(
        "SELECT * FROM lite_agent_names WHERE account_id=? ORDER BY name",
      )
      .all(account_id) as NameRow[];
    const payments = listPaymentSelectionsSync(account_id).selections;
    const agents = rows.map((row) => {
      const agent = named(row);
      const payment = payments.filter(
        (p) =>
          p.project_id === agent.endpoint.project_id &&
          p.thread_id === agent.thread_id,
      );
      return payment.length ? { ...agent, payment } : agent;
    });
    return {
      enabled: true,
      agents,
      usage: { active: agents.length, limit: MAX_NAMED_AGENTS },
      controls: { paused: false, generation: 0 },
    };
  }

  // --- payment selections ---

  type PaymentRow = {
    target_key: string;
    provider: string;
    project_id: string | null;
    path: string | null;
    thread_id: string | null;
    selection: string;
    title: string | null;
    updated_at: string;
    last_used_at: string | null;
  };

  function toResult(rows: PaymentRow[]) {
    const selections: AgentPaymentSelectionRecord[] = [];
    const defaults: AgentPaymentDefaults = {};
    for (const row of rows) {
      let selection;
      try {
        selection = parseAgentPaymentSelection(json(row.selection));
      } catch {
        continue;
      }
      if (row.target_key.startsWith("default:")) {
        (defaults as any)[selection.provider] = selection;
        continue;
      }
      if (!row.project_id || !row.thread_id) continue;
      selections.push({
        project_id: row.project_id,
        thread_id: row.thread_id,
        ...(row.path ? { path: row.path } : {}),
        provider: selection.provider,
        selection,
        ...(row.title ? { title: row.title } : {}),
        updated_at: row.updated_at,
        ...(row.last_used_at ? { last_used_at: row.last_used_at } : {}),
      });
    }
    return { selections, defaults };
  }

  function listPaymentSelectionsSync(account_id: string, provider?: string) {
    return toResult(
      db()
        .prepare(
          `SELECT * FROM lite_agent_payment_selections
            WHERE account_id=? AND (? IS NULL OR provider=?)
            ORDER BY updated_at DESC LIMIT 2000`,
        )
        .all(account_id, provider ?? null, provider ?? null) as PaymentRow[],
    );
  }

  function target(value: AgentPaymentTarget): AgentPaymentTarget {
    if (!value || typeof value !== "object") throw new Error("invalid target");
    return {
      project_id: project(value.project_id),
      thread_id: threadId(value.thread_id),
      ...(typeof value.path === "string" ? { path: value.path } : {}),
    };
  }

  async function getPaymentSelections(opts: {
    account_id?: string;
    targets: AgentPaymentTarget[];
    touch?: boolean;
  }) {
    const account_id = account(opts.account_id);
    const keys = (opts.targets ?? [])
      .slice(0, 1000)
      .map((t) => agentPaymentTargetKey(target(t)));
    const rows = db()
      .prepare("SELECT * FROM lite_agent_payment_selections WHERE account_id=?")
      .all(account_id) as PaymentRow[];
    const wanted = new Set(keys);
    if (opts.touch && keys.length)
      for (const key of keys)
        db()
          .prepare(
            "UPDATE lite_agent_payment_selections SET last_used_at=? WHERE account_id=? AND target_key=?",
          )
          .run(now(), account_id, key);
    return toResult(
      rows.filter(
        (row) =>
          wanted.has(row.target_key) || row.target_key.startsWith("default:"),
      ),
    );
  }

  async function listPaymentSelections(opts: {
    account_id?: string;
    provider?: AgentPaymentProvider;
  }) {
    return listPaymentSelectionsSync(account(opts.account_id), opts.provider);
  }

  async function setPaymentSelections(
    opts: { account_id?: string } & SetAgentPaymentSelectionsRequest,
  ): Promise<{ updated: number }> {
    const account_id = account(opts.account_id);
    const selection =
      opts.selection === null
        ? null
        : parseAgentPaymentSelection(opts.selection);
    const provider = selection?.provider ?? opts.provider;
    let updated = 0;
    const at = now();
    const write = (
      key: string,
      fields: {
        project_id?: string;
        path?: string;
        thread_id?: string;
        title?: string;
      },
    ) => {
      if (selection === null) {
        const result = db()
          .prepare(
            `DELETE FROM lite_agent_payment_selections
              WHERE account_id=? AND target_key=? AND (? IS NULL OR provider=?)`,
          )
          .run(account_id, key, provider ?? null, provider ?? null);
        updated += Number(result?.changes ?? 0);
        return;
      }
      const result = db()
        .prepare(
          `INSERT INTO lite_agent_payment_selections
             (account_id, target_key, provider, project_id, path, thread_id,
              selection, title, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, target_key, provider) DO ${
             opts.only_if_absent
               ? "NOTHING"
               : `UPDATE SET selection=excluded.selection,
                   path=COALESCE(excluded.path, path),
                   title=COALESCE(excluded.title, title),
                   updated_at=excluded.updated_at`
           }`,
        )
        .run(
          account_id,
          key,
          selection.provider,
          fields.project_id ?? null,
          fields.path ?? null,
          fields.thread_id ?? null,
          JSON.stringify(selection),
          fields.title ?? null,
          at,
        );
      updated += Number(result?.changes ?? 0);
    };
    for (const t of (opts.targets ?? []).slice(0, 1000)) {
      const checked = target(t);
      write(agentPaymentTargetKey(checked), {
        ...checked,
        title:
          typeof (t as any).title === "string"
            ? (t as any).title.slice(0, 200)
            : undefined,
      });
    }
    for (const p of opts.defaults ?? []) {
      if (p !== "codex" && p !== "claude-code")
        throw new Error("unsupported agent payment provider");
      if (selection && selection.provider !== p)
        throw new Error("a default must be for its own provider");
      write(agentPaymentDefaultKey(p), {});
    }
    return { updated };
  }

  function copyPaymentSelection(opts: {
    from: AgentPaymentTarget;
    to: AgentPaymentTarget;
  }): { copied: boolean } {
    const rows = db()
      .prepare(
        "SELECT * FROM lite_agent_payment_selections WHERE account_id=? AND target_key=?",
      )
      .all(ctx.account_id, agentPaymentTargetKey(opts.from)) as PaymentRow[];
    for (const row of rows)
      db()
        .prepare(
          `INSERT INTO lite_agent_payment_selections
             (account_id, target_key, provider, project_id, path, thread_id,
              selection, title, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, target_key, provider) DO NOTHING`,
        )
        .run(
          ctx.account_id,
          agentPaymentTargetKey(opts.to),
          row.provider,
          opts.to.project_id,
          opts.to.path ?? row.path,
          opts.to.thread_id,
          row.selection,
          row.title,
          now(),
        );
    return { copied: rows.length > 0 };
  }

  return {
    registerIdentity,
    getIdentity,
    resolveIdentity,
    startFreshConversation,
    nameAgent,
    retireNamedAgent,
    listNamedAgents,
    getPaymentSelections,
    listPaymentSelections,
    setPaymentSelections,
    copyPaymentSelection: async (opts: {
      account_id?: string;
      from: AgentPaymentTarget;
      to: AgentPaymentTarget;
    }) => {
      account(opts.account_id);
      return copyPaymentSelection({
        from: target(opts.from),
        to: target(opts.to),
      });
    },
  };
}

export type NamedAgents = ReturnType<typeof createNamedAgents>;
