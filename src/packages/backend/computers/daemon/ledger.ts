/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The operation ledger: one durable entry per operation_id, written before
// any side effect. A retry with the same operation_id gets the recorded
// outcome and never repeats the side effect; the same id with another
// request is refused. After a crash, anything admitted but unfinished is
// "unknown": `ops` reports it and the agent decides. We never guess.
// Plan: src/.agents/computers-plan-2026-10-11.md ("Operation ledger").
//
// In direct mode commands run as the same user and can edit these files, so
// the ledger is a convenience there, not evidence ("Trust boundaries").

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isValidUUID } from "@cocalc/util/misc";
import type { OperationKind } from "@cocalc/util/computers/protocol";
import { ensurePrivateDir, readJson, writeDurableJson } from "./durable";

export type LedgerState =
  | "admitted"
  | "running"
  | "done"
  | "failed"
  | "unknown";

export interface LedgerEntry {
  operation_id: string;
  operation: OperationKind;
  request_hash: string;
  /** The ticket that admitted it (a retry has a new ticket). */
  ticket_id: string;
  agent_id: string;
  source_project_id: string;
  /**
   * What authorized it (epochs), recorded before it starts so that a
   * reconciliation can tell whether it is below a later floor.
   */
  auth?: {
    source_project_id: string;
    computer_epoch: number;
    privacy_epoch: number;
    policy_epoch: number;
  };
  state: LedgerState;
  /** Exit code of an exec, or null. */
  exit_code: number | null;
  /** Small result (a job id, a refusal), never command output. */
  result: unknown;
  error: string | null;
  admitted_at: number;
  updated_at: number;
}

export class LedgerConflict extends Error {}

const OPEN: LedgerState[] = ["admitted", "running"];

export class Ledger {
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "ledger");
    ensurePrivateDir(this.dir);
  }

  private path(operation_id: string): string {
    if (!isValidUUID(operation_id)) throw new Error("bad operation_id");
    return join(this.dir, `${operation_id}.json`);
  }

  get(operation_id: string): LedgerEntry | undefined {
    return readJson<LedgerEntry>(this.path(operation_id));
  }

  /**
   * Record an admitted operation before doing anything. If the operation_id
   * is already known, nothing is written: the caller gets the existing entry
   * (`fresh: false`) and must return its outcome instead of running again.
   */
  begin(
    entry: Omit<
      LedgerEntry,
      "state" | "exit_code" | "result" | "error" | "admitted_at" | "updated_at"
    >,
    now = Date.now(),
  ): { fresh: boolean; entry: LedgerEntry } {
    const existing = this.get(entry.operation_id);
    if (existing != null) {
      if (
        existing.request_hash !== entry.request_hash ||
        existing.agent_id !== entry.agent_id ||
        existing.operation !== entry.operation ||
        existing.source_project_id !== entry.source_project_id
      ) {
        throw new LedgerConflict(
          "that operation_id was used for a different request",
        );
      }
      return { fresh: false, entry: existing };
    }
    const fresh: LedgerEntry = {
      ...entry,
      state: "admitted",
      exit_code: null,
      result: null,
      error: null,
      admitted_at: now,
      updated_at: now,
    };
    writeDurableJson(this.path(entry.operation_id), fresh);
    return { fresh: true, entry: fresh };
  }

  update(
    operation_id: string,
    patch: Partial<
      Pick<LedgerEntry, "state" | "exit_code" | "result" | "error">
    >,
    now = Date.now(),
  ): LedgerEntry {
    const entry = this.get(operation_id);
    if (entry == null) throw new Error(`no ledger entry ${operation_id}`);
    const next = { ...entry, ...patch, updated_at: now };
    writeDurableJson(this.path(operation_id), next);
    return next;
  }

  /** At startup: whatever was in flight when the daemon stopped is unknown. */
  markInterrupted(now = Date.now()): string[] {
    const marked: string[] = [];
    for (const entry of this.list()) {
      if (OPEN.includes(entry.state)) {
        this.update(
          entry.operation_id,
          {
            state: "unknown",
            error: "the daemon stopped before this operation finished",
          },
          now,
        );
        marked.push(entry.operation_id);
      }
    }
    return marked;
  }

  list(): LedgerEntry[] {
    const entries: LedgerEntry[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!isValidUUID(id)) continue;
      const entry = this.get(id);
      if (entry != null) entries.push(entry);
    }
    return entries.sort((a, b) => a.admitted_at - b.admitted_at);
  }

  /** Forget finished entries older than maxAgeMs (open ones are kept). */
  prune(maxAgeMs: number, now = Date.now()): number {
    return this.pruneIds(maxAgeMs, now).length;
  }

  /** As prune, returning the operation ids it forgot. */
  pruneIds(maxAgeMs: number, now = Date.now()): string[] {
    const removed: string[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.dir, name);
      const entry = readJson<LedgerEntry>(path);
      const age = now - (entry?.updated_at ?? statSync(path).mtimeMs);
      if (age > maxAgeMs && (entry == null || !OPEN.includes(entry.state))) {
        rmSync(path, { force: true });
        removed.push(name.slice(0, -".json".length));
      }
    }
    return removed;
  }
}
