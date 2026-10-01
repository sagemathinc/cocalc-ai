/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Account-scoped agent memory. One encrypted external-credential record per
// account (provider cocalc, kind agent-memory) in the account's home bay.
// Agent operations require the account to have enabled memory; the settings
// UI can view and delete notes either way.

import { createHash } from "node:crypto";
import {
  AGENT_MEMORY_LIMITS,
  agentMemoryIndex,
  parseAgentMemoryRecord,
  validateAgentMemoryRequest,
  validateMemoryName,
  validateMemoryWrite,
  type AgentMemoryRecord,
  type AgentMemoryRequest,
  type AgentMemoryStatus,
} from "@cocalc/conat/agents/memory";
import { isExternalCredentialConflict } from "@cocalc/util/external-credential-conflict";
import { isValidUUID } from "@cocalc/util/misc";
import {
  createExternalCredentialRouted,
  getExternalCredentialRouted,
  updateExternalCredentialByIdRouted,
} from "@cocalc/server/external-credentials/routing";

const WRITE_ATTEMPTS = 4;
export const AGENT_MEMORY_DISABLED =
  "Agent memory is off for this account. The account owner can turn it on in Settings > AI.";

type Store = {
  get(account_id: string): Promise<{ id: string; payload: string } | undefined>;
  create(account_id: string, payload: string): Promise<void>;
  update(
    account_id: string,
    id: string,
    payload: string,
    expectedSha256: string,
  ): Promise<void>;
};

function selector(account_id: string) {
  if (!isValidUUID(account_id)) throw new Error("invalid account");
  return {
    provider: "cocalc",
    kind: "agent-memory",
    scope: "account" as const,
    owner_account_id: account_id,
  };
}

export const routedStore: Store = {
  async get(account_id) {
    const row = await getExternalCredentialRouted({
      selector: selector(account_id),
      touchLastUsed: false,
    });
    return row && !row.revoked
      ? { id: row.id, payload: row.payload }
      : undefined;
  },
  async create(account_id, payload) {
    await createExternalCredentialRouted({
      selector: selector(account_id),
      payload,
      metadata: { purpose: "agent-memory" },
      // Under the store's lock, a concurrent first write fails here and
      // retries as an update instead of creating a second record.
      maxActive: 1,
    });
  },
  async update(account_id, id, payload, expectedSha256) {
    await updateExternalCredentialByIdRouted({
      id,
      selector: selector(account_id),
      payload,
      metadata: { purpose: "agent-memory" },
      expected_payload_sha256: expectedSha256,
    });
  },
};

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function isCreateRace(error: unknown): boolean {
  return /at most 1 active credentials are allowed/.test(`${error}`);
}

export function createAgentMemory(store: Store = routedStore) {
  // Serialize mutations per account within this process; CAS covers the rest.
  const queues = new Map<string, Promise<unknown>>();
  const serialized = <T>(account_id: string, fn: () => Promise<T>) => {
    const next = (queues.get(account_id) ?? Promise.resolve())
      .catch(() => {})
      .then(fn);
    queues.set(account_id, next);
    // The caller handles next's rejection; this cleanup chain must not leave
    // an unhandled one.
    next
      .finally(() => {
        if (queues.get(account_id) === next) queues.delete(account_id);
      })
      .catch(() => {});
    return next;
  };

  // repair: treat a malformed stored record as empty and disabled, so the
  // owner can always clear it. Everything else fails closed.
  const load = async (account_id: string, repair = false) => {
    const row = await store.get(account_id);
    let record: AgentMemoryRecord;
    try {
      record = parseAgentMemoryRecord(row?.payload);
    } catch (error) {
      if (!repair) throw error;
      record = { version: 1, enabled: false, notes: [] };
    }
    return { id: row?.id, sha: row ? sha256(row.payload) : undefined, record };
  };

  // Applies change; returns undefined from change to skip writing.
  const mutate = <T>(
    account_id: string,
    change: (record: AgentMemoryRecord) => { result: T; write: boolean },
    repair = false,
  ): Promise<T> =>
    serialized(account_id, async () => {
      for (let attempt = 1; ; attempt++) {
        const { id, sha, record } = await load(account_id, repair);
        const { result, write } = change(record);
        if (!write) return result;
        const payload = JSON.stringify(record);
        if (
          new TextEncoder().encode(payload).length >
          AGENT_MEMORY_LIMITS.maxRecordBytes
        )
          throw new Error(
            `agent memory would exceed ${AGENT_MEMORY_LIMITS.maxRecordBytes} bytes; delete or shorten notes first`,
          );
        try {
          if (id && sha) await store.update(account_id, id, payload, sha);
          else await store.create(account_id, payload);
          return result;
        } catch (error) {
          const retry =
            isExternalCredentialConflict(error) || isCreateRace(error);
          if (!retry || attempt >= WRITE_ATTEMPTS) throw error;
        }
      }
    });

  const status = (
    record: AgentMemoryRecord,
    bytes: number,
  ): AgentMemoryStatus => ({
    enabled: record.enabled,
    notes: record.notes.length,
    bytes,
    updated_at: record.notes
      .map((n) => n.updated_at)
      .sort()
      .at(-1),
  });

  return {
    /** Operations requested by an agent turn running as account_id. */
    async agent(account_id: string, request: AgentMemoryRequest) {
      validateAgentMemoryRequest(request);
      if (request.op === "list" || request.op === "read") {
        const { record } = await load(account_id);
        if (!record.enabled) throw new Error(AGENT_MEMORY_DISABLED);
        if (request.op === "list")
          return {
            notes: record.notes
              .map(({ name, description, updated_at }) => ({
                name,
                description,
                updated_at,
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          };
        const note = record.notes.find((n) => n.name === request.name);
        if (!note) throw new Error(`no memory note named ${request.name}`);
        return note;
      }
      if (request.op === "write") {
        const valid = validateMemoryWrite(request);
        return await mutate(account_id, (record) => {
          if (!record.enabled) throw new Error(AGENT_MEMORY_DISABLED);
          const index = record.notes.findIndex((n) => n.name === valid.name);
          if (index < 0 && record.notes.length >= AGENT_MEMORY_LIMITS.maxNotes)
            throw new Error(
              `agent memory already has ${AGENT_MEMORY_LIMITS.maxNotes} notes; delete or merge some first`,
            );
          const note = { ...valid, updated_at: new Date().toISOString() };
          if (index >= 0) record.notes[index] = note;
          else record.notes.push(note);
          return {
            result: {
              name: valid.name,
              saved: index >= 0 ? "updated" : "created",
            },
            write: true,
          };
        });
      }
      const name = validateMemoryName(request.name);
      return await mutate(account_id, (record) => {
        if (!record.enabled) throw new Error(AGENT_MEMORY_DISABLED);
        const before = record.notes.length;
        record.notes = record.notes.filter((n) => n.name !== name);
        const deleted = record.notes.length < before;
        return { result: { name, deleted }, write: deleted };
      });
    },

    /** Index for the turn context; undefined when memory is off. */
    async turnIndex(account_id: string) {
      const { record } = await load(account_id);
      if (!record.enabled) return undefined;
      return {
        notes: record.notes.length,
        index: agentMemoryIndex(record.notes),
      };
    },

    /** Settings UI (account owner only). */
    async owner(
      account_id: string,
      request:
        | { op: "status" }
        | { op: "list" }
        | { op: "set-enabled"; enabled: boolean }
        | { op: "delete"; name: string }
        | { op: "delete-all" },
    ) {
      if (request.op === "status" || request.op === "list") {
        const row = await store.get(account_id);
        const record = parseAgentMemoryRecord(row?.payload);
        const bytes = row ? new TextEncoder().encode(row.payload).length : 0;
        return request.op === "status"
          ? status(record, bytes)
          : { ...status(record, bytes), notes_list: record.notes };
      }
      if (request.op === "set-enabled") {
        if (typeof request.enabled !== "boolean")
          throw new Error("enabled must be true or false");
        return await mutate(account_id, (record) => {
          const write = record.enabled !== request.enabled;
          record.enabled = request.enabled;
          return { result: { enabled: request.enabled }, write };
        });
      }
      if (request.op === "delete") {
        const name = validateMemoryName(request.name);
        return await mutate(account_id, (record) => {
          const before = record.notes.length;
          record.notes = record.notes.filter((n) => n.name !== name);
          const deleted = record.notes.length < before;
          return { result: { name, deleted }, write: deleted };
        });
      }
      if (request.op === "delete-all")
        return await mutate(
          account_id,
          (record) => {
            const deleted = record.notes.length;
            record.notes = [];
            return { result: { deleted }, write: true };
          },
          true,
        );
      throw new Error("unsupported agent memory operation");
    },
  };
}

let singleton: ReturnType<typeof createAgentMemory> | undefined;
export function agentMemory() {
  return (singleton ??= createAgentMemory());
}
