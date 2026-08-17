/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/conat/core/client";
import { dkv, type DKV } from "@cocalc/conat/sync/dkv";

export type AgentSessionStatus =
  | "active"
  | "idle"
  | "running"
  | "archived"
  | "failed";

export interface AgentSessionRecord {
  session_id: string;
  project_id: string;
  account_id: string;
  chat_path: string;
  thread_key: string;
  title: string;
  created_at: string;
  updated_at: string;
  status: AgentSessionStatus;
  entrypoint: string;
  working_directory?: string;
  mode?: "read-only" | "workspace-write" | "full-access";
  model?: string;
  reasoning?: string;
  serviceTier?: string;
  thread_color?: string;
  thread_accent_color?: string;
  thread_icon?: string;
  thread_image?: string;
  thread_pin?: boolean;
  last_error?: string;
}

function dateMs(value: string | undefined): number {
  const ms = new Date(value ?? "").valueOf();
  return Number.isFinite(ms) ? ms : 0;
}

function validRecord(
  value: unknown,
  projectId: string,
): value is AgentSessionRecord {
  const row = value as Partial<AgentSessionRecord> | undefined;
  return !!(
    row &&
    row.project_id === projectId &&
    typeof row.session_id === "string" &&
    typeof row.chat_path === "string" &&
    row.chat_path.trim() &&
    typeof row.thread_key === "string" &&
    row.thread_key.trim()
  );
}

export function projectAgentSessions(
  entries: Record<string, unknown>,
  projectId: string,
): AgentSessionRecord[] {
  const prefix = `${projectId}::`;
  const byThread = new Map<string, AgentSessionRecord>();
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith(prefix) || !validRecord(value, projectId)) continue;
    const identity = `${value.chat_path}::${value.thread_key}`;
    const previous = byThread.get(identity);
    if (!previous || dateMs(value.updated_at) >= dateMs(previous.updated_at)) {
      byThread.set(identity, value);
    }
  }
  return [...byThread.values()].sort(
    (a, b) => dateMs(b.updated_at) - dateMs(a.updated_at),
  );
}

export class AgentSessionIndex {
  private readonly client: Client;
  private readonly projectId: string;
  private store?: DKV<AgentSessionRecord>;
  private records: AgentSessionRecord[] = [];
  private listeners = new Set<(records: AgentSessionRecord[]) => void>();
  private readonly onChange = (event?: { key?: string }) => {
    if (!event?.key || event.key.startsWith(`${this.projectId}::`)) {
      this.rebuild();
    }
  };

  constructor({ client, project_id }: { client: Client; project_id: string }) {
    this.client = client;
    this.projectId = project_id;
  }

  async open(): Promise<void> {
    if (this.store) return;
    const store = await dkv<AgentSessionRecord>({
      client: this.client,
      project_id: this.projectId,
      name: "cocalc-agent-sessions-v1",
      noCache: true,
      noInventory: true,
    });
    this.store = store;
    store.on("change", this.onChange);
    this.rebuild();
  }

  getSnapshot(): AgentSessionRecord[] {
    return this.records;
  }

  subscribe(listener: (records: AgentSessionRecord[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.records);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.store?.removeListener("change", this.onChange);
    this.store?.close();
    this.store = undefined;
    this.records = [];
    this.listeners.clear();
  }

  private rebuild(): void {
    if (!this.store) return;
    this.records = projectAgentSessions(this.store.getAll(), this.projectId);
    for (const listener of this.listeners) listener(this.records);
  }
}
