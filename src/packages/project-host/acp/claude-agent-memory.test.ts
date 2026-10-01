/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";

jest.mock("../sqlite/hosts", () => ({ getLocalHostId: () => undefined }));
jest.mock("../master-conat-client", () => ({
  getMasterConatClient: () => undefined,
}));
import { EXTERNAL_CREDENTIAL_CONFLICT } from "@cocalc/util/external-credential-conflict";
import {
  createAgentMemory,
  MAX_MEMORY_INDEX,
  memoryIndex,
  memoryPromptSection,
  type MemoryHub,
} from "./claude-agent-memory";

// In-memory stand-in for the account-scoped credential store, with the same
// compare-and-swap rule as hosts.upsertExternalCredential.
function fakeHub() {
  const state: { id?: string; payload?: string; puts: number } = { puts: 0 };
  let beforePut: (() => void) | undefined;
  const hub: MemoryHub = {
    async get() {
      return state.id ? { id: state.id, payload: state.payload! } : undefined;
    },
    async put({ id, payload, expectedSha256 }) {
      beforePut?.();
      beforePut = undefined;
      const current = state.payload
        ? createHash("sha256").update(state.payload).digest("hex")
        : undefined;
      if (current !== expectedSha256) throw Error(EXTERNAL_CREDENTIAL_CONFLICT);
      state.id = id ?? "11111111-1111-4111-8111-111111111111";
      state.payload = payload;
      state.puts += 1;
      return { id: state.id };
    },
  };
  return { hub, state, onceBeforePut: (f: () => void) => (beforePut = f) };
}

test("creates, lists, reads, updates and deletes notes", async () => {
  const { hub } = fakeHub();
  const memory = createAgentMemory(hub);
  expect(await memory.list()).toEqual({ count: 0, notes: [] });
  expect(
    await memory.write({
      name: "deploy-lite4b",
      description: "How to deploy to lite4b",
      body: "Run upgrade-all.sh in a project terminal.",
    }),
  ).toEqual({ name: "deploy-lite4b", saved: "created" });
  expect(
    await memory.write({
      name: "deploy-lite4b",
      description: "How to deploy to lite4b safely",
      body: "Run upgrade-all.sh in a project terminal, never in project_exec.",
    }),
  ).toEqual({ name: "deploy-lite4b", saved: "updated" });
  const list = await memory.list();
  expect(list.count).toBe(1);
  expect(list.notes[0]).toMatchObject({
    name: "deploy-lite4b",
    description: "How to deploy to lite4b safely",
  });
  expect(await memory.read({ name: "deploy-lite4b" })).toMatchObject({
    body: "Run upgrade-all.sh in a project terminal, never in project_exec.",
  });
  expect(await memory.delete({ name: "deploy-lite4b" })).toEqual({
    name: "deploy-lite4b",
    deleted: true,
  });
  expect(await memory.read({ name: "deploy-lite4b" })).toEqual({
    error: "no note named deploy-lite4b; see memory_list",
  });
});

test("retries a concurrent write without losing the other session's note", async () => {
  const { hub, state, onceBeforePut } = fakeHub();
  const memory = createAgentMemory(hub);
  const other = createAgentMemory(hub);
  await memory.write({ name: "a", description: "first", body: "A" });
  // Another session saves a note between this session's read and write.
  onceBeforePut(() => {
    state.payload = JSON.stringify({
      version: 1,
      entries: [
        ...JSON.parse(state.payload!).entries,
        { name: "b", description: "other", body: "B", updated_at: "" },
      ],
    });
  });
  await memory.write({ name: "c", description: "third", body: "C" });
  expect((await other.list()).notes.map((n) => n.name)).toEqual([
    "a",
    "b",
    "c",
  ]);
});

test("validates names, descriptions, bodies and size", async () => {
  const memory = createAgentMemory(fakeHub().hub);
  await expect(
    memory.write({ name: "Bad Name", description: "x", body: "y" }),
  ).rejects.toThrow(/kebab|lowercase/);
  expect(
    await memory.write({ name: "ok", description: "two\nlines", body: "y" }),
  ).toEqual({ error: expect.stringContaining("one line") });
  expect(
    await memory.write({ name: "ok", description: "d", body: "" }),
  ).toEqual({ error: expect.stringContaining("non-empty") });
  expect(
    await memory.write({
      name: "ok",
      description: "d",
      body: "x".repeat(8001),
    }),
  ).toEqual({ error: expect.stringContaining("8000") });
});

test("the prompt section lists notes and bounds the index", () => {
  const entries = Array.from({ length: 400 }, (_, i) => ({
    name: `note-${String(i).padStart(3, "0")}`,
    description: "d".repeat(100),
    body: "b",
    updated_at: "",
  }));
  const index = memoryIndex(entries);
  expect(index.length).toBeLessThan(MAX_MEMORY_INDEX + 200);
  expect(index).toMatch(/more; use memory_list/);
  const section = memoryPromptSection(entries.slice(0, 2));
  expect(section).toContain("- note-000: " + "d".repeat(100));
  expect(section).toContain("memory_write");
  expect(section).toContain("only turns launched by that account");
  expect(memoryPromptSection([])).toContain("No notes saved yet.");
});
