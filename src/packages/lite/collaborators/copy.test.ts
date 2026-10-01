/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import {
  collaborationCopySourceFingerprint,
  readCollaborationSource,
} from "@cocalc/backend/collaborators/filesystem";
import { extractCollaborationMetadata } from "@cocalc/chat";
import { initializeLiteCollaborationCopy } from "./copy";
import type { CollaborationCopy } from "@cocalc/backend/collaborators/journal";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import type { Client } from "@cocalc/conat/core/client";

jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: jest.fn(),
  releaseChatSyncDB: jest.fn(),
}));
jest.mock("@cocalc/backend/collaborators/filesystem", () => ({
  ...jest.requireActual("@cocalc/backend/collaborators/filesystem"),
  readCollaborationSource: jest.fn(),
}));
const project_id = "11111111-1111-4111-8111-111111111111";
const thread_id = "22222222-2222-4222-8222-222222222222";
const source = [
  {
    event: "chat-thread",
    thread_id,
    created_by: project_id,
    created_at: "2026-01-01T00:00:00Z",
  },
  { event: "chat-thread-config", thread_id, agent_kind: "none" },
];
let rows: Record<string, any>[];
let copy: CollaborationCopy;
let enabled: boolean;
const db = {
  get: () => rows,
  set: jest.fn((row) => rows.push(row)),
  commit: jest.fn(),
  save: jest.fn(),
  save_to_disk: jest.fn(),
};
const options = {
  project_id,
  client: {} as Client,
  reader: {} as SandboxedFilesystem,
  assertEnabled: async () => {
    if (!enabled) throw Error("disabled");
  },
};
beforeEach(() => {
  jest.clearAllMocks();
  enabled = true;
  rows = [...source];
  copy = {
    project_id,
    from_path: "/home/user/original.chat",
    chat_path: "/home/user/copied.chat",
    operation_id: "33333333-3333-4333-8333-333333333333",
    state: "ready",
    fingerprint: collaborationCopySourceFingerprint(source),
  };
  jest
    .mocked(readCollaborationSource)
    .mockImplementation(async () => [...rows]);
  jest.mocked(acquireChatSyncDB).mockResolvedValue(db as any);
  db.save.mockResolvedValue(undefined);
  db.save_to_disk.mockResolvedValue(undefined);
});

test("fresh copy gets a distinct durable discovery identity without rewriting native content", async () => {
  await initializeLiteCollaborationCopy(copy, options);
  await initializeLiteCollaborationCopy(copy, options);
  expect(db.set).toHaveBeenCalledTimes(1);
  expect(rows.slice(0, source.length)).toEqual(source);
  expect(rows).toHaveLength(source.length + 1);
  const original = extractCollaborationMetadata(source, {
    project_id,
    chat_path: copy.from_path,
  });
  const copied = extractCollaborationMetadata(rows, {
    project_id,
    chat_path: copy.chat_path,
  });
  expect(copied.resources[0].resource_id).not.toBe(
    original.resources[0].resource_id,
  );
  expect(copied.resources[0].thread_id).toBe(thread_id);
  expect(db.save_to_disk).toHaveBeenCalledTimes(2);
  expect(releaseChatSyncDB).toHaveBeenCalledTimes(2);
});

test("lost disk acknowledgment retries the same namespace", async () => {
  db.save_to_disk.mockRejectedValueOnce(Error("disk ACK lost"));
  await expect(initializeLiteCollaborationCopy(copy, options)).rejects.toThrow(
    "ACK",
  );
  await initializeLiteCollaborationCopy(copy, options);
  expect(db.set).toHaveBeenCalledTimes(1);
});

test("unknown outcomes, foreign projects and changed destinations cannot initialize copies", async () => {
  await expect(
    initializeLiteCollaborationCopy({ ...copy, state: "unknown" }, options),
  ).rejects.toThrow("reconciliation");
  await expect(
    initializeLiteCollaborationCopy(
      { ...copy, project_id: "foreign" },
      options,
    ),
  ).rejects.toThrow("foreign");
  rows = [...rows, { event: "unrelated-edit" }];
  await expect(initializeLiteCollaborationCopy(copy, options)).rejects.toThrow(
    "changed",
  );
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
});

test("feature disable before or during acquisition prevents marker writes and releases acquired handles", async () => {
  enabled = false;
  await expect(initializeLiteCollaborationCopy(copy, options)).rejects.toThrow(
    "disabled",
  );
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  enabled = true;
  jest.mocked(acquireChatSyncDB).mockImplementationOnce(async () => {
    enabled = false;
    return db as any;
  });
  await expect(initializeLiteCollaborationCopy(copy, options)).rejects.toThrow(
    "disabled",
  );
  expect(db.set).not.toHaveBeenCalled();
  expect(releaseChatSyncDB).toHaveBeenCalledTimes(1);
});
