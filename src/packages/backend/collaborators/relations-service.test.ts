import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaboratorsService } from "./service";
import { collectCollaborationRelationDraft } from "./relations";
import { verifyCollaborationRelationSet } from "@cocalc/util/collaboration-relations-codec";
import type {
  CollaborationRelation,
  CollaborationRelationPage,
} from "@cocalc/util/collaboration-relations";
import type { CollaborationSourceSnapshot } from "@cocalc/util/collaborators";
import type { CollaborationScan } from "./journal";

const source = {
  project_id: randomUUID(),
  chat_path: "/home/user/history.chat",
};
const native = {
  kind: "conversation" as const,
  resource_id: "thread",
  thread_id: "thread",
};
const resource = {
  ...source,
  ...native,
  title: "Discussion",
  activity: 0,
  participant_ids: [],
  created_at: 1,
  updated_at: 1,
};
let directory: string, instances: CollaboratorsService[], now: number;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-relation-service-"));
  instances = [];
  now = 0;
});
afterEach(async () => {
  for (const instance of instances) await instance.close();
  rmSync(directory, { recursive: true, force: true });
});
function setup(complete = true, count = 1001) {
  const pages = new Map<number, CollaborationRelationPage>();
  const epoch = randomUUID();
  const rows: CollaborationRelation[] = Array.from({ length: count }, () => ({
    kind: "participant",
    source: native,
    account_id: randomUUID(),
  }));
  let service: CollaboratorsService;
  let enabled = true;
  const opts = {
    filename: join(directory, "journal.sqlite"),
    enabled: async () => enabled,
    now: () => now,
    writerState: jest.fn(async () => null),
    register: jest.fn(async () => ({ epoch })),
    discover: jest.fn(async () => []),
    onError: jest.fn(),
    read: jest.fn(async (scan: CollaborationScan) => ({
      resources: [resource],
      activity_ids: { thread: ["message"] },
      relation_draft: await collectCollaborationRelationDraft(
        service.journal.relations,
        scan,
        rows,
        () => complete,
      ),
    })),
    stageRelationPage: jest.fn(async (page: CollaborationRelationPage) => {
      const old = pages.get(page.page);
      if (old && old.digest !== page.digest)
        throw Error("immutable page collision");
      pages.set(page.page, page);
      return { replayed: !!old };
    }),
    send: jest.fn(async (snapshot: CollaborationSourceSnapshot) => {
      if (snapshot.relations)
        await verifyCollaborationRelationSet(
          snapshot.relations,
          [...pages.values()].sort((a, b) => a.page - b.page),
        );
      return { revision: 1, replayed: false };
    }),
  };
  function open() {
    service = new CollaboratorsService(opts);
    instances.push(service);
    return service;
  }
  return {
    opts,
    pages,
    open,
    disable: () => {
      enabled = false;
    },
  };
}

test("actual worker stages a bounded prefix then atomically sends complete metadata/manifest", async () => {
  const fixture = setup();
  const service = fixture.open();
  service.journal.touch(source);
  await service.runOnce();
  expect(fixture.opts.stageRelationPage).toHaveBeenCalledTimes(4);
  expect(fixture.opts.send).not.toHaveBeenCalled();
  expect(service.journal.deliveries()).toHaveLength(1);
  await service.runOnce();
  expect(fixture.opts.stageRelationPage).toHaveBeenCalledTimes(6);
  expect(fixture.opts.send).toHaveBeenCalledTimes(1);
  expect(fixture.opts.send.mock.calls[0][0].relations).toMatchObject({
    participant_count: 1001,
    page_count: 6,
  });
  expect(service.journal.deliveries()).toEqual([]);
  expect(fixture.opts.onError).not.toHaveBeenCalled();
});
test("restart resumes durable staging without rereading the source or regenerating pages", async () => {
  const fixture = setup();
  const first = fixture.open();
  first.journal.touch(source);
  await first.runOnce();
  await first.close();
  instances = [];
  const next = fixture.open();
  fixture.opts.read.mockRejectedValue(Error("source is offline after restart"));
  await next.runOnce();
  expect(fixture.opts.read).toHaveBeenCalledTimes(1);
  expect(fixture.opts.send).toHaveBeenCalledTimes(1);
  expect(next.journal.deliveries()).toEqual([]);
});
test("lost ingest ACK retries byte-identical metadata and manifest after restart", async () => {
  const fixture = setup(true, 1);
  const first = fixture.open();
  first.journal.touch(source);
  fixture.opts.send.mockRejectedValueOnce(Error("lost reply"));
  await first.runOnce();
  const sent = fixture.opts.send.mock.calls[0][0];
  expect(sent.relations).toBeDefined();
  await first.close();
  instances = [];
  now = 2000;
  const next = fixture.open();
  await next.runOnce();
  expect(fixture.opts.send.mock.calls[1][0]).toEqual(sent);
  expect(fixture.opts.stageRelationPage).toHaveBeenCalledTimes(1);
  expect(next.journal.deliveries()).toEqual([]);
});
test("partial archive enumeration never publishes a complete empty relation manifest", async () => {
  const fixture = setup(false, 10);
  const service = fixture.open();
  service.journal.touch(source);
  await service.runOnce();
  expect(fixture.opts.stageRelationPage).not.toHaveBeenCalled();
  expect(fixture.opts.send.mock.calls[0][0].relations).toBeUndefined();
});
test("complete source with no messages explicitly commits a zero-page relation set", async () => {
  const fixture = setup(true, 0);
  const service = fixture.open();
  service.journal.touch(source);
  await service.runOnce();
  expect(fixture.opts.send.mock.calls[0][0].relations).toMatchObject({
    page_count: 0,
    participant_count: 0,
  });
  expect(fixture.opts.stageRelationPage).not.toHaveBeenCalled();
});
test("relocation between page request and ACK fences the remaining pages and metadata", async () => {
  const fixture = setup();
  const service = fixture.open();
  service.journal.touch(source);
  fixture.opts.stageRelationPage.mockImplementationOnce(async () => {
    service.journal.beginRelocation(source, "/home/user/moved.chat");
    return { replayed: false };
  });
  await service.runOnce();
  expect(fixture.opts.stageRelationPage).toHaveBeenCalledTimes(1);
  expect(fixture.opts.send).not.toHaveBeenCalled();
});
test("invalid page acknowledgement cannot advance the durable staging cursor", async () => {
  const fixture = setup(true, 1);
  const service = fixture.open();
  service.journal.touch(source);
  fixture.opts.stageRelationPage.mockResolvedValueOnce(undefined as any);
  await service.runOnce();
  expect(fixture.opts.send).not.toHaveBeenCalled();
  expect(fixture.opts.onError).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      message: "invalid collaboration relation page acknowledgement",
    }),
  );
  now = 2000;
  await service.runOnce();
  expect(fixture.opts.stageRelationPage).toHaveBeenCalledTimes(2);
  expect(fixture.opts.stageRelationPage.mock.calls[1][0]).toEqual(
    fixture.opts.stageRelationPage.mock.calls[0][0],
  );
  expect(fixture.opts.send).toHaveBeenCalledTimes(1);
});
test("disabled producer does no source or relation transport work", async () => {
  const fixture = setup();
  const service = fixture.open();
  service.journal.touch(source);
  fixture.disable();
  await service.runOnce();
  expect(fixture.opts.read).not.toHaveBeenCalled();
  expect(fixture.opts.stageRelationPage).not.toHaveBeenCalled();
  expect(fixture.opts.send).not.toHaveBeenCalled();
});
