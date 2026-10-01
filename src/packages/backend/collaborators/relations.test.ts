import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CollaborationRelation,
  CollaborationRelationManifest,
  CollaborationRelationPage,
} from "@cocalc/util/collaboration-relations";
import { verifyCollaborationRelationSet } from "@cocalc/util/collaboration-relations-codec";
import type { CollaborationSourceSnapshot } from "@cocalc/util/collaborators";
import { SourceRelations } from "./relations";

const project_id = randomUUID(),
  epoch = randomUUID(),
  chat_path = "/home/user/room.chat";
const scan = { project_id, epoch, chat_path, generation: 1 };
const source = {
  kind: "conversation" as const,
  resource_id: "thread",
  thread_id: "thread",
};
const snapshot: CollaborationSourceSnapshot = {
  project_id,
  epoch,
  chat_path,
  sequence: 1,
  resources: [
    {
      ...source,
      project_id,
      chat_path,
      title: "Discussion",
      activity: 1,
      participant_ids: [],
      created_at: 1,
      updated_at: 1,
    },
  ],
};
const person = (): CollaborationRelation => ({
  kind: "participant",
  source,
  account_id: randomUUID(),
});
let db: DatabaseSync;
let store: SourceRelations;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  store = new SourceRelations(db);
});
afterEach(() => {
  db.close();
});
function prepared(rows: CollaborationRelation[] = []) {
  const draft = store.begin(scan);
  for (let offset = 0; offset < rows.length; offset += 1000)
    store.append(draft, rows.slice(offset, offset + 1000));
  store.bind(scan, store.seal(draft), snapshot);
  return draft;
}
function receiver() {
  const pages = new Map<number, CollaborationRelationPage>();
  const manifests: CollaborationRelationManifest[] = [];
  return {
    pages,
    manifests,
    stage: jest.fn(async (page: CollaborationRelationPage) => {
      pages.set(page.page, page);
    }),
    commit: jest.fn(async (manifest: CollaborationRelationManifest) => {
      await verifyCollaborationRelationSet(
        manifest,
        [...pages.values()].sort((a, b) => a.page - b.page),
      );
      manifests.push(manifest);
    }),
  };
}

test("full participants deduplicate and page past the preview limit, never activate a prefix", async () => {
  const rows = Array.from({ length: 450 }, person);
  prepared([...rows, rows[0]]);
  const remote = receiver();
  expect(await store.deliver(snapshot, remote, () => true, 1)).toBe(false);
  expect(remote.commit).not.toHaveBeenCalled();
  expect(await store.deliver(snapshot, remote, () => true, 1)).toBe(false);
  expect(await store.deliver(snapshot, remote, () => true, 1)).toBe(true);
  expect([...remote.pages.values()].map((p) => p.rows.length)).toEqual([
    200, 200, 50,
  ]);
  expect(remote.manifests[0].participant_count).toBe(450);
  expect(remote.manifests[0].snapshot).toEqual({
    project_id,
    epoch,
    chat_path,
    sequence: 1,
  });
});
test("large reference rows also respect 256KiB wire pages", async () => {
  const rows: CollaborationRelation[] = Array.from({ length: 300 }, (_, i) => ({
    kind: "reference",
    source: {
      ...source,
      resource_id: "r".repeat(256),
      thread_id: "t".repeat(256),
    },
    message_id: `${i}`.padStart(256, "0"),
    reference: {
      version: 1,
      target: { project_id, kind: "artifact", resource_id: "界".repeat(256) },
    },
  }));
  const input = {
    ...snapshot,
    resources: [
      {
        ...snapshot.resources[0],
        resource_id: "r".repeat(256),
        thread_id: "t".repeat(256),
      },
    ],
  };
  const draft = store.begin(scan);
  store.append(draft, rows);
  store.bind(scan, store.seal(draft), input);
  const remote = receiver();
  expect(await store.deliver(input, remote)).toBe(true);
  expect(remote.pages.size).toBeGreaterThan(1);
  for (const page of remote.pages.values()) {
    expect(page.rows.length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      256 * 1024,
    );
  }
});
test("SQLite ordering matches protocol UTF-16 ordering for non-BMP authored IDs", async () => {
  const rows: CollaborationRelation[] = ["\ue000", "\u{10000}"].map(
    (resource_id) => ({
      kind: "reference",
      source,
      message_id: "message",
      reference: {
        version: 1,
        target: { project_id, kind: "artifact", resource_id },
      },
    }),
  );
  prepared(rows);
  const remote = receiver();
  expect(await store.deliver(snapshot, remote)).toBe(true);
  expect(remote.pages.get(0)!.rows).toEqual([rows[1], rows[0]]);
});
test("page ACK loss replays identical bytes and does not advance before success", async () => {
  prepared([person()]);
  const remote = receiver();
  remote.stage.mockImplementationOnce(async (page) => {
    remote.pages.set(page.page, page);
    throw Error("lost ACK");
  });
  await expect(store.deliver(snapshot, remote)).rejects.toThrow("lost ACK");
  const first = JSON.stringify(remote.pages.get(0));
  expect(await store.deliver(snapshot, remote)).toBe(true);
  expect(remote.stage).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(remote.pages.get(0))).toBe(first);
});
test("manifest ACK loss retains the delivery and retries the identical manifest", async () => {
  prepared([person()]);
  const remote = receiver();
  remote.commit.mockRejectedValueOnce(Error("lost commit"));
  await expect(store.deliver(snapshot, remote)).rejects.toThrow("lost commit");
  expect(() => store.acknowledge(snapshot)).toThrow("not been committed");
  expect(await store.deliver(snapshot, remote)).toBe(true);
  expect(remote.commit.mock.calls[0][0]).toEqual(
    remote.commit.mock.calls[1][0],
  );
  expect(remote.stage).toHaveBeenCalledTimes(1);
});
test("only a sealed complete empty draft can clear relations", async () => {
  const remote = receiver();
  expect(await store.deliver(snapshot, remote)).toBe(true);
  expect(remote.commit).not.toHaveBeenCalled();
  const draft = store.begin(scan);
  expect(() => store.bind(scan, draft, snapshot)).toThrow("fence");
  store.bind(scan, store.seal(draft), snapshot);
  expect(await store.deliver(snapshot, remote)).toBe(true);
  expect(remote.stage).not.toHaveBeenCalled();
  expect(remote.manifests[0]).toMatchObject({
    page_count: 0,
    participant_count: 0,
    reference_count: 0,
  });
});
test("read-generation or writer changes cannot bind a complete draft", () => {
  const draft = store.seal(store.begin(scan));
  expect(() => store.bind({ ...scan, generation: 2 }, draft, snapshot)).toThrow(
    "fence",
  );
  expect(() =>
    store.bind(scan, draft, { ...snapshot, epoch: randomUUID() }),
  ).toThrow("fence");
});
test("foreign or already canonicalized native provenance is rejected before delivery", () => {
  const draft = store.begin(scan);
  store.append(draft, [
    { ...person(), source: { ...source, resource_id: "different" } },
  ]);
  store.seal(draft);
  expect(() => store.bind(scan, draft, snapshot)).toThrow(
    "native source snapshot",
  );
});
test("late page responses after writer invalidation never permit activation", async () => {
  prepared([person()]);
  let current = true;
  const remote = receiver();
  remote.stage.mockImplementationOnce(async () => {
    current = false;
  });
  expect(await store.deliver(snapshot, remote, () => current)).toBe(false);
  expect(remote.commit).not.toHaveBeenCalled();
});
test("writer/locator recovery retains captured facts but regenerates all epoch-bound hashes", async () => {
  const row = person();
  prepared([row]);
  const before = receiver();
  await store.deliver(snapshot, before);
  const next = {
    ...snapshot,
    epoch: randomUUID(),
    chat_path: "/home/user/moved.chat",
  };
  store.rebind(snapshot, next);
  expect(store.has(snapshot)).toBe(false);
  const after = receiver();
  await store.deliver(next, after);
  expect(after.pages.get(0)!.rows).toEqual([row]);
  expect(after.pages.get(0)!.digest).not.toBe(before.pages.get(0)!.digest);
  expect(after.manifests[0].snapshot).toMatchObject({
    epoch: next.epoch,
    chat_path: next.chat_path,
  });
});
test("notification-only batches reuse committed set and cleanup is transactional", async () => {
  prepared([person()]);
  const remote = receiver();
  await store.deliver(snapshot, remote);
  const next = { ...snapshot, sequence: 2 };
  store.acknowledge(snapshot, next);
  expect(await store.deliver(next, remote)).toBe(true);
  expect(remote.commit).toHaveBeenCalledTimes(2);
  expect(remote.commit.mock.calls[1][0]).toEqual(
    remote.commit.mock.calls[0][0],
  );
  expect(remote.stage).toHaveBeenCalledTimes(1);
  store.acknowledge(next);
  expect(db.prepare("SELECT count(*) AS n FROM relation_rows").get()!.n).toBe(
    0,
  );
  expect(db.prepare("SELECT count(*) AS n FROM relation_pages").get()!.n).toBe(
    0,
  );
});
test("oversized append rolls back without losing the previous complete candidates", () => {
  const draft = store.begin(scan);
  store.append(draft, [person()]);
  expect(() =>
    store.append(draft, Array.from({ length: 1001 }, person)),
  ).toThrow("batch");
  expect(
    db
      .prepare("SELECT row_count FROM relation_drafts WHERE draft_id=?")
      .get(draft)!.row_count,
  ).toBe(1);
  const tiny = new SourceRelations(db, { drafts: 10, bytes: 1 });
  expect(() => tiny.append(draft, [person()])).toThrow("journal capacity");
  expect(
    db
      .prepare("SELECT row_count FROM relation_drafts WHERE draft_id=?")
      .get(draft)!.row_count,
  ).toBe(1);
});
test("restart retains bound immutable pages and discards abandoned unsealed reads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "collaboration-relations-"));
  db.close();
  try {
    const filename = join(directory, "journal.sqlite");
    db = new DatabaseSync(filename);
    store = new SourceRelations(db);
    db.exec(
      "CREATE TABLE deliveries(project_id TEXT,chat_path TEXT,epoch TEXT,sequence INTEGER)",
    );
    db.prepare("INSERT INTO deliveries VALUES(?,?,?,?)").run(
      project_id,
      chat_path,
      epoch,
      1,
    );
    prepared(Array.from({ length: 201 }, person));
    store.begin({ ...scan, chat_path: "/home/user/abandoned.chat" });
    const remote = receiver();
    expect(await store.deliver(snapshot, remote, () => true, 1)).toBe(false);
    const first = remote.pages.get(0);
    db.close();
    db = new DatabaseSync(filename);
    store = new SourceRelations(db);
    store.recover();
    expect(
      db.prepare("SELECT count(*) AS n FROM relation_drafts").get()!.n,
    ).toBe(1);
    expect(await store.deliver(snapshot, remote)).toBe(true);
    expect(remote.stage).toHaveBeenCalledTimes(2);
    expect(remote.pages.get(0)).toEqual(first);
  } finally {
    db.close();
    db = new DatabaseSync(":memory:");
    rmSync(directory, { recursive: true, force: true });
  }
});
