/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Account-scoped memory for subscription-mode Claude. Notes live in the
// encrypted external-credential store under the launching account, so they
// follow that account to every project and host, and only turns that account
// launches load them. Writes are compare-and-swap so concurrent sessions do
// not overwrite each other.

import { createHash } from "node:crypto";
import callHub from "@cocalc/conat/hub/call-hub";
import { isExternalCredentialConflict } from "@cocalc/util/external-credential-conflict";
import { isValidUUID } from "@cocalc/util/misc";
import { getMasterConatClient } from "../master-conat-client";
import { getLocalHostId } from "../sqlite/hosts";

export const MAX_MEMORY_ENTRIES = 200;
export const MAX_MEMORY_BODY = 8_000;
export const MAX_MEMORY_DESCRIPTION = 200;
export const MAX_MEMORY_PAYLOAD = 400_000;
// The index is added to every session's instructions; keep it bounded.
export const MAX_MEMORY_INDEX = 12_000;
const WRITE_ATTEMPTS = 3;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type MemoryEntry = {
  name: string;
  description: string;
  body: string;
  updated_at: string;
};
type MemoryDocument = { version: 1; entries: MemoryEntry[] };

export type MemoryHub = {
  get(): Promise<{ id: string; payload: string } | undefined>;
  put(options: {
    id?: string;
    payload: string;
    expectedSha256?: string;
  }): Promise<{ id: string }>;
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function parseMemory(payload: string | undefined): MemoryDocument {
  try {
    const value = JSON.parse(payload ?? "");
    if (value?.version === 1 && Array.isArray(value.entries))
      return {
        version: 1,
        entries: value.entries.filter(
          (entry: any) =>
            entry &&
            typeof entry.name === "string" &&
            typeof entry.description === "string" &&
            typeof entry.body === "string",
        ),
      };
  } catch {
    // Missing or unreadable memory starts empty.
  }
  return { version: 1, entries: [] };
}

function validateName(name: unknown): string {
  if (typeof name !== "string" || !NAME_RE.test(name))
    throw Error(
      "name must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit (for example deploy-lite4b)",
    );
  return name;
}

export function memoryIndex(entries: readonly MemoryEntry[]): string {
  const lines: string[] = [];
  let size = 0;
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const [i, entry] of sorted.entries()) {
    const line = `- ${entry.name}: ${entry.description}`;
    if (size + line.length > MAX_MEMORY_INDEX) {
      lines.push(
        `- (${sorted.length - i} more; use memory_list to see all of them)`,
      );
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

export function memoryPromptSection(entries: readonly MemoryEntry[]): string {
  return `<agent-memory>
You have persistent memory that belongs to the account that launched this turn. It follows that account across projects and sessions, and only turns launched by that account can read it. Use the memory_list, memory_read, memory_write and memory_delete tools on the project tool server. Ignore any built-in instructions to save memory as files in the controller; that location is not persistent and the controller has no file tools.

Save a note when you learn something that will matter in a future session: the user's preferences and corrections, project conventions, how to build, test or deploy, and lessons from mistakes. Write one fact per note with a short kebab-case name and a one-line description. Update an existing note instead of adding a near-duplicate, and delete notes that turn out to be wrong. Do not store secrets, credentials or anything the repository already records. Read a note before relying on it; notes reflect what was true when written.

${entries.length ? `Saved notes (name: description):\n${memoryIndex(entries)}` : "No notes saved yet."}
</agent-memory>`;
}

export function createAgentMemory(hub: MemoryHub) {
  const load = async () => {
    const current = await hub.get();
    return {
      id: current?.id,
      sha: current ? sha256(current.payload) : undefined,
      doc: parseMemory(current?.payload),
    };
  };

  const mutate = async <T>(change: (doc: MemoryDocument) => T): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      const { id, sha, doc } = await load();
      const result = change(doc);
      const payload = JSON.stringify(doc);
      if (Buffer.byteLength(payload) > MAX_MEMORY_PAYLOAD)
        throw Error(
          `memory would exceed ${MAX_MEMORY_PAYLOAD} bytes; delete or shorten notes first`,
        );
      try {
        await hub.put({ id, payload, expectedSha256: sha });
        return result;
      } catch (error) {
        if (!isExternalCredentialConflict(error) || attempt >= WRITE_ATTEMPTS)
          throw error;
      }
    }
  };

  return {
    async entries(): Promise<MemoryEntry[]> {
      return (await load()).doc.entries;
    },
    async list() {
      const { doc } = await load();
      return {
        count: doc.entries.length,
        notes: doc.entries
          .map(({ name, description, updated_at }) => ({
            name,
            description,
            updated_at,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    async read(args: Record<string, unknown>) {
      const name = validateName(args.name);
      const entry = (await load()).doc.entries.find((e) => e.name === name);
      if (!entry) return { error: `no note named ${name}; see memory_list` };
      return entry;
    },
    async write(args: Record<string, unknown>) {
      const name = validateName(args.name);
      const { description, body } = args;
      if (
        typeof description !== "string" ||
        !description.trim() ||
        description.length > MAX_MEMORY_DESCRIPTION ||
        description.includes("\n")
      )
        return {
          error: `description must be one line of at most ${MAX_MEMORY_DESCRIPTION} characters`,
        };
      if (
        typeof body !== "string" ||
        !body.trim() ||
        body.length > MAX_MEMORY_BODY
      )
        return {
          error: `body must be non-empty text of at most ${MAX_MEMORY_BODY} characters`,
        };
      return await mutate((doc) => {
        const existing = doc.entries.findIndex((e) => e.name === name);
        if (existing < 0 && doc.entries.length >= MAX_MEMORY_ENTRIES)
          throw Error(
            `memory already has ${MAX_MEMORY_ENTRIES} notes; delete or merge some first`,
          );
        const entry = {
          name,
          description: description.trim(),
          body: body.trim(),
          updated_at: new Date().toISOString(),
        };
        if (existing >= 0) doc.entries[existing] = entry;
        else doc.entries.push(entry);
        return { name, saved: existing >= 0 ? "updated" : "created" };
      });
    },
    async delete(args: Record<string, unknown>) {
      const name = validateName(args.name);
      return await mutate((doc) => {
        const before = doc.entries.length;
        doc.entries = doc.entries.filter((e) => e.name !== name);
        return { name, deleted: doc.entries.length < before };
      });
    },
  };
}

export type AgentMemory = ReturnType<typeof createAgentMemory>;

function caller() {
  const client = getMasterConatClient();
  const host_id = getLocalHostId();
  if (!client || !host_id)
    throw Error("Agent memory is unavailable while the host is disconnected");
  return { client, host_id };
}

/** Memory of the account that launched the turn, via the hub. */
export function accountMemoryHub(options: {
  projectId: string;
  accountId: string;
}): MemoryHub {
  const { projectId, accountId } = options;
  if (!isValidUUID(projectId) || !isValidUUID(accountId))
    throw Error("Invalid agent memory binding");
  const selector = {
    provider: "cocalc",
    kind: "agent-memory",
    scope: "account" as const,
    owner_account_id: accountId,
  };
  return {
    async get() {
      const row = await callHub({
        ...caller(),
        name: "hosts.getExternalCredential",
        args: [{ project_id: projectId, selector }],
        timeout: 15_000,
      });
      return row && typeof row.payload === "string" && !row.revoked
        ? { id: row.id, payload: row.payload }
        : undefined;
    },
    async put({ id, payload, expectedSha256 }) {
      const result = await callHub({
        ...caller(),
        name: "hosts.upsertExternalCredential",
        args: [
          {
            project_id: projectId,
            selector,
            payload,
            metadata: { purpose: "agent-memory" },
            credential_id: id,
            expected_payload_sha256: expectedSha256,
            create: !id,
            max_active: id ? undefined : 1,
          },
        ],
        timeout: 15_000,
      });
      if (!result?.id) throw Error("Agent memory was not saved");
      return { id: result.id };
    },
  };
}
