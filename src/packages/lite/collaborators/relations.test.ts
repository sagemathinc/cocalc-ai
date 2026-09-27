import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LiteCollaborators } from "./index";
import type {
  CollaborationResource,
  CollaborationSourceSnapshot,
} from "@cocalc/util/collaborators";
import { collaborationRelationKey } from "@cocalc/util/collaboration-relations";
import type {
  CollaborationRelation,
  CollaborationRelationPage,
} from "@cocalc/util/collaboration-relations";
import { createCollaborationRelationSet } from "@cocalc/util/collaboration-relations-codec";
import type { CollaborationAgentIdentity } from "@cocalc/util/collaboration-agent-identity";

const project_id = randomUUID(),
  account_id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const chat_path = "/home/user/relations.chat";
let directory: string,
  filename: string,
  epoch: string,
  store: LiteCollaborators,
  enabled: boolean;
let identities: CollaborationAgentIdentity[];
function open() {
  return new LiteCollaborators({
    filename,
    project_id,
    account_id,
    isEnabled: () => enabled,
    agentIdentities: () => identities,
  });
}
function resource(
  id = "thread",
  changes: Partial<CollaborationResource> = {},
): CollaborationResource {
  return {
    project_id,
    chat_path,
    kind: "conversation",
    resource_id: id,
    thread_id: id,
    title: id,
    activity: 2,
    created_at: 1,
    updated_at: 2,
    participant_ids: [],
    ...changes,
  };
}
function snapshot(
  sequence = 1,
  resources = [resource()],
): CollaborationSourceSnapshot {
  return { project_id, chat_path, epoch, sequence, resources };
}
const native = (r: CollaborationResource) => ({
  kind: r.kind as "conversation" | "agent",
  resource_id: r.resource_id,
  thread_id: r.thread_id,
});
const person = (id = account_id, r = resource()): CollaborationRelation => ({
  kind: "participant",
  source: native(r),
  account_id: id,
});
const reference = (
  r = resource(),
  message_id = randomUUID(),
): CollaborationRelation => ({
  kind: "reference",
  source: native(r),
  message_id,
  reference: {
    version: 1,
    target: {
      project_id: randomUUID(),
      kind: "artifact",
      resource_id: "artifact:authored-target",
    },
  },
});
const query = (r = resource()) => ({
  account_id,
  project_id,
  kind: r.kind,
  resource_id: r.resource_id,
});
async function set(rows: CollaborationRelation[], input = snapshot()) {
  const pages: CollaborationRelationPage[] = [];
  const { project_id, chat_path, epoch, sequence } = input;
  const manifest = await createCollaborationRelationSet(
    { project_id, chat_path, epoch, sequence },
    [...rows].sort((a, b) =>
      collaborationRelationKey(a) < collaborationRelationKey(b) ? -1 : 1,
    ),
    (page) => {
      pages.push(page);
    },
  );
  return { pages, manifest, input: { ...input, relations: manifest } };
}
async function publish(rows: CollaborationRelation[], input = snapshot()) {
  const result = await set(rows, input);
  for (const page of result.pages) await store.stageRelationPage({ page });
  await store.ingest({ snapshot: result.input });
  return result;
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "lite-collaboration-relations-"));
  filename = join(directory, "catalog.sqlite");
  enabled = true;
  identities = [];
  store = open();
  ({ epoch } = await store.registerSource({
    project_id,
    chat_path,
    expected_epoch: null,
    registration_id: randomUUID(),
  }));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("staging 200 rows never exposes a prefix or advances metadata on incomplete commit", async () => {
  await store.ingest({ snapshot: snapshot() });
  const rows = Array.from({ length: 201 }, () => person(randomUUID()));
  const upload = await set(
    rows,
    snapshot(2, [resource("thread", { activity: 100 })]),
  );
  await store.stageRelationPage({ page: upload.pages[0] });
  expect(await store.api.listParticipants(query())).toMatchObject({
    items: [],
    coverage: "partial",
  });
  await expect(store.ingest({ snapshot: upload.input })).rejects.toThrow(
    "incomplete relation set",
  );
  expect(await store.api.getResource(query())).toMatchObject({ activity: 2 });
  await store.stageRelationPage({ page: upload.pages[1] });
  await store.ingest({ snapshot: upload.input });
  expect((await store.api.listParticipants(query())).items).toHaveLength(50);
});
test("abandoned old-epoch sets do not exhaust a migrated writer's pending quota", async () => {
  for (const sequence of [1, 2]) {
    const upload = await set([person()], snapshot(sequence));
    await store.stageRelationPage({ page: upload.pages[0] });
  }
  const oldEpoch = epoch;
  ({ epoch } = await store.registerSource({
    project_id,
    chat_path,
    expected_epoch: oldEpoch,
    registration_id: randomUUID(),
  }));
  expect(epoch).not.toBe(oldEpoch);
  await publish([person()]);
  expect(await store.api.listParticipants(query())).toMatchObject({
    items: [{ account_id }],
    coverage: "complete",
  });
  const db = new DatabaseSync(filename);
  try {
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM collaboration_relation_sets WHERE epoch=?",
        )
        .get(oldEpoch)!.n,
    ).toBe(0);
  } finally {
    db.close();
  }
});
test("participants beyond capped preview drive person and For You queries, with keyset pages", async () => {
  const ids = [
    ...Array.from({ length: 249 }, () => randomUUID()),
    account_id,
  ].sort();
  const r = resource("thread", {
    participant_ids: ids.slice(0, 64),
    participant_count: 250,
    participants_truncated: true,
  });
  expect(r.participant_ids).not.toContain(account_id);
  await publish(
    ids.map((id) => person(id, r)),
    snapshot(1, [r]),
  );
  const first = await store.api.listParticipants(query());
  expect(first.coverage).toBe("complete");
  expect(first.items).toHaveLength(50);
  const all = first.items.map((row) => row.account_id);
  let after = first.next;
  while (after) {
    const page = await store.api.listParticipants({ ...query(), after });
    expect(page.items.length).toBeLessThanOrEqual(50);
    all.push(...page.items.map((row) => row.account_id));
    after = page.next;
  }
  expect(all).toEqual(ids);
  expect(
    (await store.api.listResources({ account_id, person_id: account_id }))
      .items,
  ).toHaveLength(1);
  expect(
    (await store.api.listResources({ account_id, scope: "for-you" })).items,
  ).toHaveLength(1);
});
test("preview-only metadata is not silently promoted into complete participant relations", async () => {
  await store.ingest({
    snapshot: snapshot(1, [
      resource("thread", { participant_ids: [account_id] }),
    ]),
  });
  expect(await store.api.listParticipants(query())).toMatchObject({
    items: [],
    coverage: "partial",
  });
  expect(
    (await store.api.listResources({ account_id, person_id: account_id }))
      .items,
  ).toEqual([]);
});
test("resource preview and exact count are rebuilt from full relations, including archived participants", async () => {
  const ids = Array.from({ length: 251 }, () => randomUUID()).sort();
  await publish(ids.map((id) => person(id)));
  expect(await store.api.getResource(query())).toMatchObject({
    participant_ids: ids.slice(0, 64),
    participant_count: 251,
    participants_truncated: true,
  });
});
test("missing relations preserve the previous set with partial coverage; verified empty clears it", async () => {
  await publish([person()]);
  await store.ingest({ snapshot: snapshot(2) });
  expect(await store.api.listParticipants(query())).toMatchObject({
    items: [{ account_id }],
    coverage: "partial",
  });
  await publish([], snapshot(3));
  expect(await store.api.listParticipants(query())).toMatchObject({
    items: [],
    coverage: "complete",
  });
});
test("copied native provenance and authored target survive paged storage without aliases", async () => {
  const r = resource(`copy:${randomUUID()}`, { thread_id: "native-thread" });
  const edge = reference(r, "message");
  await publish([edge], snapshot(1, [r]));
  expect(await store.api.listReferences(query(r))).toMatchObject({
    items: [edge],
    coverage: "complete",
  });
  expect(
    (await store.api.listReferences({ ...query(r), message_id: "other" }))
      .items,
  ).toEqual([]);
  expect(
    (await store.api.listReferences({ ...query(r), message_id: "message" }))
      .items,
  ).toEqual([edge]);
});
test("registered agent adaptation keeps native old/current threads separate in relations", async () => {
  const agent_id = randomUUID();
  identities = [
    {
      agent_id,
      project_id,
      path: chat_path,
      thread_id: "new",
      conversation_history: [{ thread_id: "old" }],
    },
  ];
  const old = resource("agent-thread:old", { kind: "agent", thread_id: "old" });
  const current = resource("agent-thread:new", {
    kind: "agent",
    thread_id: "new",
  });
  const edges = [reference(old), reference(current)];
  const currentParticipant = randomUUID();
  await publish(
    [...edges, person(account_id, old), person(currentParticipant, current)],
    snapshot(1, [old, current]),
  );
  const canonical = { ...query(current), resource_id: agent_id };
  expect((await store.api.listReferences(canonical)).items).toEqual([edges[1]]);
  expect((await store.api.listParticipants(canonical)).items).toEqual([
    { account_id: currentParticipant },
  ]);
  expect((await store.api.listReferences(query(old))).items).toHaveLength(1);
  expect(identities).toHaveLength(1);
});
test("fresh registered-agent thread never borrows its predecessor's complete relations", async () => {
  const agent_id = randomUUID();
  identities = [{ agent_id, project_id, path: chat_path, thread_id: "old" }];
  const old = resource("agent-thread:old", { kind: "agent", thread_id: "old" });
  await publish([person(account_id, old), reference(old)], snapshot(1, [old]));
  const target = { ...query(old), resource_id: agent_id };
  expect((await store.api.listReferences(target)).items).toHaveLength(1);
  identities[0] = {
    ...identities[0],
    thread_id: "fresh",
    conversation_history: [{ thread_id: "old" }],
  };
  expect(await store.api.listParticipants(target)).toMatchObject({
    items: [],
    coverage: "indexing",
  });
  expect(await store.api.listReferences(query(old))).toMatchObject({
    items: [],
    coverage: "indexing",
  });
  const fresh = resource("agent-thread:fresh", {
    kind: "agent",
    thread_id: "fresh",
  });
  // Even a metadata-only update must not attach old native edges to the new thread.
  await store.ingest({ snapshot: snapshot(2, [old, fresh]) });
  expect(await store.api.listParticipants(target)).toMatchObject({
    items: [],
    coverage: "partial",
  });
  expect((await store.api.listReferences(target)).items).toEqual([]);
  await publish([person(randomUUID(), fresh)], snapshot(3, [old, fresh]));
  expect(await store.api.listReferences(target)).toMatchObject({
    items: [],
    coverage: "complete",
  });
});
test("public relation pages share the 50-row limit and check-compatible revision tokens", async () => {
  await publish(Array.from({ length: 51 }, () => reference()));
  const page = await store.api.listReferences(query());
  expect(page.items).toHaveLength(50);
  expect(page.next).toBeDefined();
  expect(
    await store.api.check({ account_id, since: page.revision }),
  ).toMatchObject({ reset: false });
  await expect(
    store.api.listReferences({ ...query(), limit: 51 }),
  ).rejects.toThrow(/limit/);
  await expect(
    store.api.listParticipants({ ...query(), limit: 200 }),
  ).rejects.toThrow(/limit/);
  await expect(
    store.api.listParticipants({ ...query(), message_id: "message" }),
  ).rejects.toThrow("message filter");
  await publish([], snapshot(2));
  expect(
    await store.api.check({ account_id, since: page.revision }),
  ).toMatchObject({ reset: true });
});
test("page and manifest ACK retries survive reopen; committed payloads are compacted", async () => {
  const upload = await set([person()]);
  await store.stageRelationPage({ page: upload.pages[0] });
  store.close();
  store = open();
  expect(await store.stageRelationPage({ page: upload.pages[0] })).toEqual({
    replayed: true,
  });
  await store.ingest({ snapshot: upload.input });
  store.close();
  store = open();
  expect(await store.ingest({ snapshot: upload.input })).toMatchObject({
    replayed: true,
  });
  expect(await store.stageRelationPage({ page: upload.pages[0] })).toEqual({
    replayed: true,
  });
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    expect(
      db.prepare("SELECT payload FROM collaboration_relation_pages").get()!
        .payload,
    ).toBeNull();
  } finally {
    db.close();
  }
});
test("conflicting immutable page retries cannot replace an activated relation set", async () => {
  await publish([person()]);
  const changed = await set([person(randomUUID())]);
  await expect(
    store.stageRelationPage({ page: changed.pages[0] }),
  ).rejects.toThrow("conflicting immutable");
  await expect(store.ingest({ snapshot: changed.input })).rejects.toThrow(
    "conflicting committed",
  );
  expect((await store.api.listParticipants(query())).items).toEqual([
    { account_id },
  ]);
});
test("new writer epoch rejects stale uploads and old manifest activation", async () => {
  const upload = await set([person()]);
  await store.stageRelationPage({ page: upload.pages[0] });
  const registered = await store.registerSource({
    project_id,
    chat_path,
    expected_epoch: epoch,
    registration_id: randomUUID(),
  });
  await expect(
    store.stageRelationPage({ page: upload.pages[0] }),
  ).rejects.toThrow("writer epoch");
  await expect(
    store.ingest({ snapshot: { ...upload.input, epoch: registered.epoch } }),
  ).rejects.toThrow("writer epoch");
});
test("complete new-path relations replace old bindings after a mediated source move", async () => {
  await publish([person()]);
  const movedPath = "/home/user/moved.chat";
  const moved = await store.relocateSource({
    project_id,
    operation_id: randomUUID(),
    from_chat_path: chat_path,
    to_chat_path: movedPath,
    expected_epoch: epoch,
    expected_destination_epoch: null,
  });
  expect(await store.api.listParticipants(query())).toMatchObject({
    items: [{ account_id }],
    coverage: "partial",
  });
  const replacement = {
    ...snapshot(),
    chat_path: movedPath,
    epoch: moved.epoch,
    resources: [{ ...resource(), chat_path: movedPath }],
  };
  await publish([], replacement);
  expect(await store.api.listParticipants(query())).toMatchObject({
    items: [],
    coverage: "complete",
  });
});
test("notification-only sequence reuses an already committed manifest, never an uncommitted old set", async () => {
  const upload = await publish([person()]);
  await store.ingest({ snapshot: { ...upload.input, sequence: 2 } });
  expect(await store.api.listParticipants(query())).toMatchObject({
    items: [{ account_id }],
    coverage: "complete",
  });
  const pending = await set([person(randomUUID())], snapshot(3));
  await store.stageRelationPage({ page: pending.pages[0] });
  await expect(
    store.ingest({ snapshot: { ...pending.input, sequence: 4 } }),
  ).rejects.toThrow("uncommitted old");
});
test("native provenance mismatch rolls back metadata and relation activation together", async () => {
  await publish([person()]);
  const upload = await set(
    [person(account_id, resource("forged"))],
    snapshot(2),
  );
  await store.stageRelationPage({ page: upload.pages[0] });
  await expect(store.ingest({ snapshot: upload.input })).rejects.toThrow(
    "native provenance",
  );
  expect(await store.api.listParticipants(query())).toMatchObject({
    items: [{ account_id }],
    coverage: "complete",
  });
});
test("disabled and foreign callers cannot publish or browse relation metadata", async () => {
  const upload = await publish([person()]);
  await expect(
    store.api.stageRelationPage({ page: upload.pages[0] }),
  ).rejects.toThrow("service-local");
  await expect(
    store.api.listParticipants({ ...query(), account_id: randomUUID() }),
  ).rejects.toThrow("local Lite account");
  enabled = false;
  await expect(
    store.stageRelationPage({ page: upload.pages[0] }),
  ).rejects.toThrow("disabled");
  await expect(store.api.listReferences(query())).rejects.toThrow("disabled");
});
