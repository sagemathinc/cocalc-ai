import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLiteCollaborators } from "./service";
import {
  rotateChatStore,
  deleteChatStoreData,
} from "@cocalc/backend/chat-store/sqlite-offload";
import { serializeCollaborationReference } from "@cocalc/util/collaboration-references";

const project_id = randomUUID(),
  thread_id = randomUUID();
const account_id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const target = {
  project_id: randomUUID(),
  kind: "artifact" as const,
  resource_id: "artifact:authored-reference",
};
const atom = serializeCollaborationReference({
  version: 1,
  target,
  display_fallback: "Published result",
});
let directory: string,
  source: string,
  db_path: string,
  oldArchive: string | undefined;
let runtime: ReturnType<typeof createLiteCollaborators> | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "lite-relations-reader-"));
  mkdirSync(join(directory, "project"));
  source = join(directory, "project", "history.chat");
  db_path = join(directory, "offload.sqlite");
  oldArchive = process.env.COCALC_CHAT_OFFLOAD_DB;
  process.env.COCALC_CHAT_OFFLOAD_DB = db_path;
});
afterEach(async () => {
  jest.restoreAllMocks();
  await runtime?.close();
  runtime = undefined;
  if (oldArchive === undefined) delete process.env.COCALC_CHAT_OFFLOAD_DB;
  else process.env.COCALC_CHAT_OFFLOAD_DB = oldArchive;
  rmSync(directory, { recursive: true, force: true });
});
function write(rows: unknown[]) {
  writeFileSync(
    source,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
}
function head(): Record<string, any>[] {
  return readFileSync(source, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((row) => JSON.parse(row));
}
async function fixture(count = 1001) {
  const root = "2026-01-01T00:00:00.000Z";
  const messages = Array.from({ length: count }, (_, i) => ({
    event: "chat",
    schema_version: 2,
    message_id: `message-${i}`,
    thread_id,
    sender_id:
      i === count - 3
        ? account_id
        : `${i.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    date: new Date(Date.parse(root) + i * 1000).toISOString(),
    ...(i ? { parent_message_id: "message-0", reply_to: root } : {}),
    history: [{ content: i === count - 3 ? atom : `body-${i}` }],
  }));
  write([
    { event: "chat-thread", thread_id, created_at: root },
    {
      event: "chat-thread-config",
      thread_id,
      agent_kind: "none",
      name: "Full history",
    },
    ...messages,
  ]);
  await rotateChatStore({
    chat_path: source,
    db_path,
    keep_recent_messages: 2,
    force: true,
  });
  expect(head().filter((row) => row.event === "chat")).toHaveLength(3);
  return messages;
}
function open() {
  runtime = createLiteCollaborators({
    directory: join(directory, "private"),
    path: join(directory, "project"),
    project_id,
    account_id,
    isEnabled: () => true,
    sourcePage: async () => ({ paths: [source] }),
    agentPins: {
      read: () => [],
      set: () => {
        throw Error("unexpected agent enrollment");
      },
    },
  });
  return runtime;
}
const query = () => ({
  account_id,
  project_id,
  kind: "conversation" as const,
  resource_id: thread_id,
});

test("real saved head/archive produces uncapped participants and authored references after restart", async () => {
  await fixture();
  let service = open();
  await service.service.runOnce();
  expect((await service.api.listResources({ account_id })).items).toEqual([]);
  expect(service.service.journal.deliveries()).toHaveLength(1);
  await service.close();
  runtime = undefined;
  // The remaining immutable relation pages do not need the original file.
  rmSync(source);
  service = open();
  await service.service.runOnce();
  const resource = await service.api.getResource(query());
  expect(resource).toMatchObject({
    participant_count: 1001,
    participants_truncated: true,
  });
  expect(resource!.participant_ids).toHaveLength(64);
  expect(resource!.participant_ids).not.toContain(account_id);
  expect(
    (
      await service.api.listResources({ account_id, scope: "for-you" })
    ).items.map((r) => r.resource_id),
  ).toEqual([thread_id]);
  const refs = await service.api.listReferences(query());
  expect(refs).toMatchObject({
    coverage: "complete",
    items: [
      expect.objectContaining({
        message_id: "message-998",
        reference: { version: 1, target },
      }),
    ],
  });
  expect(JSON.stringify(resource)).not.toContain("body-");
});

test("head edits override archived versions and known archive deletions can remove edges", async () => {
  const messages = await fixture(70);
  const service = open();
  await service.service.runOnce();
  expect((await service.api.listReferences(query())).items).toHaveLength(1);
  const edited = {
    ...messages[67],
    history: [
      { content: "Reference removed by edit" },
      ...messages[67].history,
    ],
  };
  write([...head(), edited]);
  service.service.journal.touch({ project_id, chat_path: source });
  await service.service.runOnce();
  expect(await service.api.listReferences(query())).toMatchObject({
    coverage: "complete",
    items: [],
  });
  await rotateChatStore({
    chat_path: source,
    db_path,
    keep_recent_messages: 2,
    force: true,
  });
  service.service.journal.touch({ project_id, chat_path: source });
  await service.service.runOnce();
  expect(await service.api.listReferences(query())).toMatchObject({
    coverage: "complete",
    items: [],
  });
  deleteChatStoreData({
    chat_path: source,
    db_path,
    scope: "messages",
    message_ids: [messages[67].message_id],
  });
  service.service.journal.touch({ project_id, chat_path: source });
  await service.service.runOnce();
  expect(
    (await service.api.listResources({ account_id, person_id: account_id }))
      .items,
  ).toEqual([]);
  expect(
    (await service.api.listResources({ account_id, scope: "for-you" })).items,
  ).toEqual([]);
});

test("missing declared archive preserves prior state instead of publishing a partial replacement", async () => {
  await fixture(70);
  const service = open();
  await service.service.runOnce();
  expect((await service.api.listReferences(query())).items).toHaveLength(1);
  process.env.COCALC_CHAT_OFFLOAD_DB = join(directory, "missing.sqlite");
  service.service.journal.touch({ project_id, chat_path: source });
  await service.service.runOnce();
  expect((await service.api.listReferences(query())).items).toHaveLength(1);
  expect(
    service.service.journal.censusProgress(project_id).source_errors,
  ).toBeGreaterThan(0);
  expect(
    (
      await service.api.listResources({ account_id, scope: "for-you" })
    ).items.map((resource) => resource.resource_id),
  ).toEqual([thread_id]);
});

test("unparseable message references preserve metadata and old relations with explicit partial coverage", async () => {
  await fixture(70);
  const service = open();
  await service.service.runOnce();
  write(
    head().map((row) => (row.event === "chat" ? { ...row, history: [] } : row)),
  );
  service.service.journal.touch({ project_id, chat_path: source });
  await service.service.runOnce();
  expect(await service.api.getResource(query())).not.toBeNull();
  expect(await service.api.listReferences(query())).toMatchObject({
    coverage: "partial",
    items: [expect.objectContaining({ reference: { version: 1, target } })],
  });
  expect(
    (await service.api.listResources({ account_id })).coverage_message,
  ).toContain("Complete participant/reference indexing deferred");
  const forYou = await service.api.listResources({
    account_id,
    scope: "for-you",
  });
  expect(forYou.items.map((resource) => resource.resource_id)).toEqual([
    thread_id,
  ]);
  expect(forYou.coverage).toBe("partial");
});
