import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaboratorsService } from "@cocalc/backend/collaborators/service";
import { collectCollaborationRelationDraft } from "@cocalc/backend/collaborators/relations";
import type { CollaborationScan } from "@cocalc/backend/collaborators/journal";
import type { CollaborationRelation } from "@cocalc/util/collaboration-relations";
import { LiteCollaborators } from "./index";

const project_id = randomUUID(),
  account_id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const source = { project_id, chat_path: "/home/user/history.chat" };
const native = {
  kind: "conversation" as const,
  resource_id: "thread",
  thread_id: "thread",
};
let directory: string, owner: LiteCollaborators, worker: CollaboratorsService;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "lite-relations-producer-"));
});
afterEach(async () => {
  await worker?.close();
  owner?.close();
  rmSync(directory, { recursive: true, force: true });
});
function setup(count = 1001) {
  const participants = Array.from(
    { length: count - 1 },
    (_, i) => `${i.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  ).concat(account_id);
  const facts: CollaborationRelation[] = participants.map((id) => ({
    kind: "participant",
    source: native,
    account_id: id,
  }));
  const read = jest.fn(async (scan: CollaborationScan) => ({
    resources: [
      {
        ...source,
        ...native,
        title: "Archive discussion",
        activity: 0,
        participant_ids: participants.slice(0, 64),
        participant_count: count,
        participants_truncated: count > 64,
        created_at: 1,
        updated_at: 1,
      },
    ],
    activity_ids: { thread: ["message"] },
    relation_draft: await collectCollaborationRelationDraft(
      worker.journal.relations,
      scan,
      facts,
      () => true,
    ),
  }));
  const errors = jest.fn();
  let now = 0;
  function open() {
    owner = new LiteCollaborators({
      filename: join(directory, "catalog.sqlite"),
      project_id,
      account_id,
      isEnabled: () => true,
    });
    worker = new CollaboratorsService({
      filename: join(directory, "journal.sqlite"),
      enabled: async () => true,
      now: () => now,
      writerState: (request) => owner.writerState(request),
      register: (request) => owner.registerSource(request),
      stageRelationPage: (page) => owner.stageRelationPage({ page }),
      send: (snapshot) => owner.ingest({ snapshot }),
      read,
      discover: async () => [],
      onError: errors,
    });
  }
  open();
  worker.journal.touch(source);
  return {
    read,
    errors,
    open,
    advance: () => {
      now += 2000;
    },
  };
}

test("real worker stages hidden pages and resumes into Lite full participation after both stores restart", async () => {
  const fixture = setup();
  await worker.runOnce();
  expect((await owner.api.listResources({ account_id })).items).toEqual([]);
  expect(worker.journal.deliveries()).toHaveLength(1);
  await worker.close();
  owner.close();
  fixture.open();
  fixture.read.mockRejectedValue(Error("source offline after staging"));
  await worker.runOnce();
  expect(fixture.read).toHaveBeenCalledTimes(1);
  expect(fixture.errors).not.toHaveBeenCalled();
  expect(worker.journal.deliveries()).toEqual([]);
  const target = {
    account_id,
    project_id,
    kind: native.kind,
    resource_id: native.resource_id,
  };
  const resource = await owner.api.getResource(target);
  expect(resource).toMatchObject({
    participant_count: 1001,
    participants_truncated: true,
  });
  expect(resource!.participant_ids).not.toContain(account_id);
  expect(
    (await owner.api.listResources({ account_id, scope: "for-you" })).items.map(
      (r) => r.resource_id,
    ),
  ).toEqual(["thread"]);
  const participants: string[] = [];
  let after: string | undefined;
  do {
    const page = await owner.api.listParticipants({
      ...target,
      limit: 50,
      after,
    });
    expect(page.coverage).toBe("complete");
    expect(page.items.length).toBeLessThanOrEqual(50);
    participants.push(...page.items.map((item) => item.account_id));
    after = page.next;
  } while (after);
  expect(participants).toHaveLength(1001);
  expect(participants).toContain(account_id);
});

test("lost Lite activation reply replays the manifest after compaction without reread", async () => {
  const fixture = setup(2);
  const ingest = owner.ingest.bind(owner);
  jest.spyOn(owner, "ingest").mockImplementationOnce(async (request) => {
    await ingest(request);
    throw Error("lost activation reply");
  });
  await worker.runOnce();
  expect(worker.journal.deliveries()).toHaveLength(1);
  await worker.close();
  owner.close();
  fixture.open();
  fixture.advance();
  fixture.read.mockRejectedValue(Error("must replay durable pages"));
  await worker.runOnce();
  expect(worker.journal.deliveries()).toEqual([]);
  expect(fixture.read).toHaveBeenCalledTimes(1);
  expect(
    await owner.api.listParticipants({
      account_id,
      project_id,
      kind: native.kind,
      resource_id: native.resource_id,
    }),
  ).toMatchObject({
    coverage: "complete",
    items: expect.arrayContaining([{ account_id }]),
  });
});
