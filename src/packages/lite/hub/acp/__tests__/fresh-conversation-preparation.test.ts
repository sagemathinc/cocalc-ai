import { randomUUID } from "node:crypto";
import type { Client } from "@cocalc/conat/core/client";
import { buildThreadConfigRecord } from "@cocalc/chat";
import { prepareFreshConversation } from "../fresh-conversation";
import { closeAcpDatabase, initAcpDatabase } from "../../sqlite/acp-database";

const acquire = jest.fn();
const release = jest.fn();
jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: (...args) => acquire(...args),
  releaseChatSyncDB: (...args) => release(...args),
}));

const key = {
  project_id: randomUUID(),
  path: "/home/user/agent.chat",
  thread_id: "old",
  account_id: randomUUID(),
};
const client = {} as Client;
let rows: any[];
let db: {
  get: jest.Mock;
  set: jest.Mock;
  commit: jest.Mock;
  save: jest.Mock;
  save_to_disk: jest.Mock;
  isReady: jest.Mock;
};
beforeEach(() => {
  initAcpDatabase({ filename: ":memory:" });
  rows = [
    buildThreadConfigRecord({
      thread_id: "old",
      updated_by: key.account_id,
      agent_kind: "acp",
      acp_config: {
        sessionId: "old-provider-session",
        workingDirectory: "/work",
      },
    }),
    { event: "chat", thread_id: "old", content: "Keep this old conversation" },
  ];
  db = {
    get: jest.fn(() => rows),
    set: jest.fn((row) => {
      rows.push(row);
    }),
    commit: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    save_to_disk: jest.fn().mockResolvedValue(undefined),
    isReady: jest.fn().mockReturnValue(true),
  };
  acquire.mockReset().mockResolvedValue(db);
  release.mockReset().mockResolvedValue(undefined);
});
afterEach(closeAcpDatabase);

test("disk-write failure cannot mark the successor ready, and retry completes the same disk write", async () => {
  db.save_to_disk.mockRejectedValueOnce(new Error("disk full"));
  await expect(prepareFreshConversation(key, client)).rejects.toThrow(
    "disk full",
  );
  const successor = rows[2].thread_id;
  await expect(prepareFreshConversation(key, client)).resolves.toBe(successor);
  expect(db.set).toHaveBeenCalledTimes(1);
  expect(db.save_to_disk).toHaveBeenCalledTimes(2);
});

test("returns only after saving, preserves old rows, and does not rewrite a used successor", async () => {
  const old = structuredClone(rows);
  let finishSave!: () => void;
  db.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
  );
  const completed = jest.fn();
  const preparing = prepareFreshConversation(key, client).then((id) => {
    completed();
    return id;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(db.save).toHaveBeenCalledTimes(1);
  expect(completed).not.toHaveBeenCalled();
  await expect(prepareFreshConversation(key, client)).rejects.toThrow(
    "already being prepared",
  );
  finishSave();
  const successor = await preparing;
  expect(rows.slice(0, 2)).toEqual(old);
  const config = rows.find((row) => row.thread_id === successor);
  expect(config.acp_config).toEqual({ workingDirectory: "/work" });
  config.acp_config.sessionId = "new-provider-session";
  rows.push({
    event: "chat",
    thread_id: successor,
    content: "New conversation work",
  });
  const afterUse = structuredClone(rows);
  await expect(prepareFreshConversation(key, client)).resolves.toBe(successor);
  expect(rows).toEqual(afterUse);
  expect(db.set).toHaveBeenCalledTimes(1);
  expect(db.save).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(3);
});

test("an explicit retry after save failure saves the same successor without losing old messages", async () => {
  db.save.mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(prepareFreshConversation(key, client)).rejects.toThrow(
    "disk unavailable",
  );
  const successor = rows[2].thread_id;
  await expect(prepareFreshConversation(key, client)).resolves.toBe(successor);
  expect(db.set).toHaveBeenCalledTimes(1);
  expect(db.save).toHaveBeenCalledTimes(2);
  expect(rows.filter((row) => row.event === "chat")).toEqual([
    { event: "chat", thread_id: "old", content: "Keep this old conversation" },
  ]);
});

test("enabled scheduled work is rejected before creating any successor", async () => {
  rows[0].automation_config = { enabled: true };
  await expect(prepareFreshConversation(key, client)).rejects.toThrow(
    "Disable scheduled work",
  );
  expect(db.set).not.toHaveBeenCalled();
  expect(db.save).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});
