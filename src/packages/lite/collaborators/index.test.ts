/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CollaborationResource,
  CollaborationSourceSnapshot,
} from "@cocalc/util/collaborators";
import { LiteCollaborators } from "./index";
import type { LiteCollaboratorsOptions } from "./index";
import * as limits from "./validation";
import { createCollaborationRelationSet } from "@cocalc/util/collaboration-relations-codec";
import { collaborationRelationKey } from "@cocalc/util/collaboration-relations";
import type { CollaborationRelation } from "@cocalc/util/collaboration-relations";

const project_id = "11111111-1111-4111-8111-111111111111";
const account_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const chat_path = "/home/user/discussion.chat";
const local = { account_id, project_id };
let directory: string;
let options: LiteCollaboratorsOptions;
let store: LiteCollaborators;
let epoch: string;
let enabled: boolean;

test("standalone Lite explicitly rejects owner-routed Scan operations", async () => {
  await expect(
    store.api.requestScan({ ...local, request_id: account_id, mode: "check" }),
  ).rejects.toThrow("not supported in standalone Lite");
  await expect(
    store.api.inspectScan({ ...local, request_id: account_id }),
  ).rejects.toThrow("not supported in standalone Lite");
  await expect(
    store.api.getScanStatus({ ...local, job_id: account_id }),
  ).rejects.toThrow("not supported in standalone Lite");
});

function resource(
  id = "thread-a",
  changes: Partial<CollaborationResource> = {},
): CollaborationResource {
  return {
    project_id,
    chat_path,
    kind: "conversation",
    resource_id: id,
    thread_id: id,
    title: `Geometry ${id}`,
    participant_ids: [],
    created_at: 10,
    updated_at: 20,
    activity: 5,
    ...changes,
  };
}

function snapshot(
  sequence = 1,
  resources = [resource()],
): CollaborationSourceSnapshot {
  return { project_id, chat_path, epoch, sequence, resources };
}

async function ingest(sequence = 1, resources = [resource()]) {
  return store.ingest({ snapshot: snapshot(sequence, resources) });
}

test("shared-participant scope requires complete relations and excludes imported nonlocal participants", async () => {
  const shared_with = {
    project_id,
    kind: "conversation" as const,
    resource_id: "thread-a",
  };
  await ingest();
  expect(
    await store.api.listResources({ ...local, shared_with }),
  ).toMatchObject({ items: [], coverage: "indexing" });
  expect(
    (
      await store.api.listResources({
        ...local,
        shared_with,
        include_unshared: true,
      })
    ).items,
  ).toMatchObject([{ shared_with_all_participants: false }]);
  await ingestCompleteRelations(2, [
    resource("thread-a", { participant_ids: [account_id] }),
  ]);
  expect(
    (await store.api.listResources({ ...local, shared_with })).items,
  ).toHaveLength(1);
  expect(
    (
      await store.api.listResources({
        ...local,
        shared_with,
        include_unshared: true,
      })
    ).items,
  ).toMatchObject([{ shared_with_all_participants: true }]);
  await ingestCompleteRelations(3, [
    resource("thread-a", {
      participant_ids: [account_id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    }),
  ]);
  expect(
    (await store.api.listResources({ ...local, shared_with })).items,
  ).toEqual([]);
  expect(
    (
      await store.api.listResources({
        ...local,
        shared_with,
        include_unshared: true,
      })
    ).items,
  ).toMatchObject([{ shared_with_all_participants: false }]);
});

test("private chat aliases reuse local personal state and people cannot invent membership", async () => {
  await ingest();
  await store.api.setPersonalState({
    ...local,
    kind: "conversation",
    resource_id: "thread-a",
    patch: { alias: "weekly" },
  });
  await expect(
    store.api.resolveChatAlias({ account_id, alias: "Weekly" }),
  ).resolves.toMatchObject({ resource_id: "thread-a" });
  await expect(
    store.api.resolveChatAlias({ account_id, alias: "missing" }),
  ).resolves.toBeNull();
  await expect(
    store.api.resolveChatAlias({ account_id: "other", alias: "weekly" }),
  ).rejects.toThrow();
  await expect(
    store.api.resolvePersonAlias({ account_id, alias: "alice" }),
  ).resolves.toBeNull();
  await expect(
    store.api.setPersonAlias({
      account_id,
      person_id: "other",
      alias: "alice",
    }),
  ).rejects.toThrow("not accessible");
});

// These small fixtures explicitly describe the whole participant set. Runtime
// producers must derive it from full history, never from the preview array.
async function ingestCompleteRelations(
  sequence: number,
  resources: CollaborationResource[],
) {
  const rows: CollaborationRelation[] = resources.flatMap((resource) =>
    resource.kind === "artifact"
      ? []
      : resource.participant_ids.map((account_id) => ({
          kind: "participant" as const,
          source: {
            kind: resource.kind as "agent" | "conversation",
            resource_id: resource.resource_id,
            thread_id: resource.thread_id,
          },
          account_id,
        })),
  );
  rows.sort((a, b) =>
    collaborationRelationKey(a) < collaborationRelationKey(b) ? -1 : 1,
  );
  const relations = await createCollaborationRelationSet(
    { project_id, chat_path, epoch, sequence },
    rows,
    async (page) => {
      await store.stageRelationPage({ page });
    },
  );
  return store.ingest({
    snapshot: { ...snapshot(sequence, resources), relations },
  });
}

function reopen(): void {
  store.close();
  store = new LiteCollaborators(options);
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "lite-collaborators-"));
  enabled = true;
  options = {
    filename: join(directory, "collaborators.sqlite"),
    ...local,
    isEnabled: () => enabled,
    project_title: "Geometry Lab",
  };
  store = new LiteCollaborators(options);
  ({ epoch } = await store.registerSource({
    project_id,
    chat_path,
    registration_id: "writer-1",
    expected_epoch: null,
  }));
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
  jest.restoreAllMocks();
});

test("browsing uses only the durable service index; no room, file or invented human", async () => {
  const before = readdirSync(directory);
  expect(await store.api.listPeople(local)).toEqual({
    items: [],
    coverage: "complete",
    revision: expect.any(String),
  });
  expect(await store.api.listProjects(local)).toEqual({
    items: [
      { project_id, title: "Geometry Lab", description: "", role: "owner" },
    ],
    coverage: "complete",
    revision: expect.any(String),
  });
  expect(
    await store.api.listProjects({ ...local, person_id: "stranger" }),
  ).toMatchObject({ items: [] });
  expect(
    await store.api.listProjects({ ...local, search: "geom" }),
  ).toMatchObject({ items: [{ project_id }] });
  expect(await store.api.listResources(local)).toMatchObject({
    items: [],
    coverage: "partial",
  });
  const db = new DatabaseSync(options.filename);
  expect(
    db.prepare("SELECT count(*) AS n FROM collaboration_room").get()?.n,
  ).toBe(0);
  db.close();
  expect(readdirSync(directory)).toEqual(before);
  expect(statSync(options.filename).mode & 0o777).toBe(0o600);

  await ingest(1, [
    resource("unnamed-agent", {
      kind: "agent",
      agent_id: "agent-1",
      participant_ids: ["imported-author"],
    }),
  ]);
  reopen();
  const page = await store.api.listResources(local);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    kind: "agent",
    personal: { collected: false, following: false, read_through: 0 },
  });
  expect(page.items[0].personal?.alias).toBeUndefined();
  expect(page.coverage).toBe("partial");
  expect(await store.api.listPeople(local)).toEqual({
    items: [],
    coverage: "complete",
    revision: expect.any(String),
  });
});

test("latest-message author survives Lite validation and restart without replacing creator", async () => {
  const created_by = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const authored = resource("thread-a", {
    created_by,
    latest_message_author_id: account_id.toUpperCase(),
  });
  await ingest(1, [authored]);
  reopen();
  expect((await store.api.listResources(local)).items[0]).toMatchObject({
    created_by,
    latest_message_author_id: account_id,
  });
  await ingest(2, [{ ...authored, title: "Renamed" }]);
  expect((await store.api.listResources(local)).items[0]).toMatchObject({
    title: "Renamed",
    latest_message_author_id: account_id,
    activity: authored.activity,
  });
  await ingest(3, [resource()]);
  expect((await store.api.listResources(local)).items[0]).not.toHaveProperty(
    "latest_message_author_id",
  );
  for (const latest_message_author_id of ["invalid", "", 42]) {
    expect(() =>
      limits.snapshot(
        snapshot(4, [
          resource("thread-a", {
            latest_message_author_id: latest_message_author_id as any,
          }),
        ]),
      ),
    ).toThrow("latest_message_author_id");
  }
  for (const kind of ["agent", "artifact"] as const) {
    expect(() =>
      limits.snapshot(
        snapshot(4, [
          resource("thread-a", { kind, latest_message_author_id: account_id }),
        ]),
      ),
    ).toThrow("latest_message_author_id");
  }
});

test.each([undefined, "stranger", "project-principal"])(
  "every human method requires the local account: %s",
  async (other) => {
    const request = { ...local, account_id: other };
    for (const call of [
      () => store.api.check(request),
      () => store.api.listProjectResources(request),
      () => store.api.requestSource({ ...request, chat_path }),
      () => store.api.listPeople(request),
      () => store.api.listProjects(request),
      () => store.api.listResources(request),
      () => store.api.getResource({ ...resource(), ...request }),
      () =>
        store.api.setPersonalState({
          ...resource(),
          ...request,
          patch: { collected: true },
        }),
      () => store.api.ensureRoom({ ...request, request_id: "room" }),
    ])
      await expect(call()).rejects.toThrow("local Lite account");
  },
);

test("feature disable blocks every human RPC without stopping internal ingestion", async () => {
  enabled = false;
  await ingest();
  for (const call of [
    () => store.api.check(local),
    () => store.api.listProjectResources(local),
    () => store.api.requestSource({ ...local, chat_path }),
    () => store.api.listPeople(local),
    () => store.api.listProjects(local),
    () => store.api.listResources(local),
    () => store.api.getResource({ ...resource(), ...local }),
    () =>
      store.api.setPersonalState({
        ...resource(),
        ...local,
        patch: { collected: true },
      }),
    () => store.api.ensureRoom({ ...local, request_id: "room" }),
  ])
    await expect(call()).rejects.toThrow("disabled");
  enabled = true;
  expect((await store.api.listResources(local)).items).toHaveLength(1);
  enabled = false;
  await expect(store.api.listResources(local)).rejects.toThrow("disabled");
});

test("network writer methods are never enabled, even for a purported host", async () => {
  await expect(
    store.api.roomForHost({
      project_id,
      host_id: "host",
      requesting_account_id: account_id,
    }),
  ).rejects.toThrow("no remote hosts");
  await expect(
    store.api.registerSource({
      project_id,
      chat_path,
      registration_id: "host",
      host_id: "host",
      expected_epoch: epoch,
    }),
  ).rejects.toThrow("service-local");
  await expect(
    store.api.ingest({ host_id: "host", snapshot: snapshot() }),
  ).rejects.toThrow("service-local");
  expect((await store.api.listResources(local)).items).toEqual([]);
});

test("unchanged personal writes do not invalidate pagination and cursors use an indexed tuple", async () => {
  await ingest(1, [resource(), resource("other")]);
  const target = { ...resource(), ...local };
  await store.api.setPersonalState({ ...target, patch: { alias: "notes" } });
  const first = await store.api.listResources({ ...local, limit: 1 });
  await store.api.setPersonalState({ ...target, patch: { alias: "notes" } });
  await expect(
    store.api.listResources({ ...local, limit: 1, after: first.next }),
  ).resolves.toMatchObject({ items: [expect.any(Object)] });
  expect(
    (await store.api.listResources({ ...local, search: '"*' })).items,
  ).toEqual([]);
  const db = new DatabaseSync(options.filename);
  try {
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT resource_key FROM collaboration_resources WHERE deleted=0 AND (sort_at,resource_key)>(?,?) ORDER BY sort_at,resource_key LIMIT 51",
      )
      .all(-20, "key");
    expect(plan.map((row) => row.detail).join(" ")).toMatch(
      /SEARCH .*collaboration_resource_page.*sort_at/,
    );
    expect(plan.map((row) => row.detail).join(" ")).not.toContain(
      "TEMP B-TREE",
    );
  } finally {
    db.close();
  }
});

test("foreign projects and database owner reuse fail closed", async () => {
  const foreign = { ...local, project_id: "foreign" };
  for (const call of [
    () => store.api.listPeople(foreign),
    () => store.api.listProjects(foreign),
    () => store.api.listResources(foreign),
    () => store.api.getResource({ ...resource(), ...foreign }),
    () =>
      store.api.setPersonalState({
        ...resource(),
        ...foreign,
        patch: { following: true },
      }),
    () => store.api.ensureRoom({ ...foreign, request_id: "room" }),
    () => store.writerState({ ...foreign, chat_path }),
    () => store.sourcePage(foreign),
    () => store.ingest({ snapshot: { ...snapshot(), project_id: "foreign" } }),
  ])
    await expect(call()).rejects.toThrow("project");
  expect(
    () => new LiteCollaborators({ ...options, account_id: "stranger" }),
  ).toThrow("another account or project");
  expect(
    () => new LiteCollaborators({ ...options, project_id: "foreign" }),
  ).toThrow("another account or project");
  await ingest();
  expect((await store.api.listResources(local)).items).toHaveLength(1);
});

test("canonical room converges across requests, connections and restart without creating chat content", async () => {
  const second = new LiteCollaborators(options);
  try {
    const [a, b] = await Promise.all([
      store.api.ensureRoom({ ...local, request_id: "first" }),
      second.api.ensureRoom({ ...local, request_id: "second" }),
    ]);
    expect(a).toEqual(b);
    reopen();
    expect(
      await store.api.ensureRoom({ ...local, request_id: "retry" }),
    ).toEqual(a);
    expect((await store.api.listResources(local)).items).toEqual([]);
    expect(
      readdirSync(directory).every((name) =>
        name.startsWith("collaborators.sqlite"),
      ),
    ).toBe(true);
  } finally {
    second.close();
  }
});

test("aliases, collection, attention and monotone read state persist independently", async () => {
  await ingest(1, [
    resource("thread-a", { activity: 0 }),
    resource("other", { activity: 0 }),
  ]);
  await ingest(2, [resource(), resource("other")]);
  const target = { ...resource(), ...local };
  await store.api.setPersonalState({
    ...target,
    patch: { alias: "@Notes", collected: true },
  });
  expect(
    (await store.api.listResources({ ...local, scope: "following" })).items,
  ).toEqual([]);
  await store.api.setPersonalState({
    ...target,
    patch: { following: true, muted: true, read_through: 4 },
  });
  await store.api.setPersonalState({ ...target, patch: { read_through: 2 } });
  await store.api.setPersonalState({ ...target, patch: { collected: false } });
  reopen();
  expect((await store.api.getResource(target))?.personal).toEqual({
    alias: "notes",
    collected: false,
    following: true,
    muted: true,
    read_through: 4,
  });
  expect(
    (await store.api.getResource({ ...resource("other"), ...local }))?.personal
      ?.read_through,
  ).toBe(0);
  expect(
    (await store.api.listResources({ ...local, scope: "following" })).items,
  ).toHaveLength(1);
  expect(
    (await store.api.listResources({ ...local, search: "not" })).items,
  ).toHaveLength(1);
  expect(
    (await store.api.listResources({ ...local, scope: "collected" })).items,
  ).toEqual([]);
  await expect(
    store.api.setPersonalState({
      ...target,
      patch: { alias: "", read_through: 5000 },
    }),
  ).rejects.toThrow("exceeds current source activity");
  const state = await store.api.setPersonalState({
    ...target,
    patch: { alias: "", read_through: 5 },
  });
  expect(state).toEqual({
    collected: false,
    following: true,
    muted: true,
    read_through: 5,
  });
  await ingest(3, [
    resource("thread-a", { title: "New title", activity: 1 }),
    resource("other"),
  ]);
  expect((await store.api.getResource(target))?.activity).toBe(5);
  expect((await store.api.getResource(target))?.personal?.read_through).toBe(5);
});

test("per-kind aliases collide only within their own type and never create discovery", async () => {
  const agent = resource("agent", { kind: "agent", agent_id: "agent" });
  await ingest(1, [resource(), resource("other"), agent]);
  await store.api.setPersonalState({
    ...resource(),
    ...local,
    patch: { alias: "shared" },
  });
  await store.api.setPersonalState({
    ...agent,
    ...local,
    patch: { alias: "shared" },
  });
  await expect(
    store.api.setPersonalState({
      ...resource("other"),
      ...local,
      patch: { alias: "SHARED", collected: true },
    }),
  ).rejects.toThrow("alias already used");
  expect(
    (await store.api.getResource({ ...resource("other"), ...local }))?.personal
      ?.collected,
  ).toBe(false);
  await expect(
    store.api.setPersonalState({
      ...resource("missing"),
      ...local,
      patch: { alias: "new" },
    }),
  ).rejects.toThrow("unavailable");
  expect(
    (await store.api.listResources({ ...local, search: "shared" })).items,
  ).toHaveLength(2);
});

test("following and participation explain For you without collection or mute changing membership", async () => {
  await ingestCompleteRelations(1, [
    resource(),
    resource("participated", { participant_ids: [account_id] }),
    resource("unrelated"),
  ]);
  const target = { ...resource(), ...local };
  await store.api.setPersonalState({
    ...target,
    patch: { following: true, muted: true },
  });
  const page = await store.api.listResources({ ...local, scope: "for-you" });
  expect(page.items.map((item) => [item.resource_id, item.reason])).toEqual([
    ["participated", "participation"],
    ["thread-a", "following"],
  ]);
  expect(page.items[0].personal?.following).toBe(false);
  await store.api.setPersonalState({
    ...target,
    patch: { following: false, collected: true },
  });
  expect(
    (await store.api.listResources({ ...local, scope: "for-you" })).items.map(
      (item) => item.resource_id,
    ),
  ).toEqual(["participated"]);
});

test("fenced full-source snapshots replay idempotently and removal survives stale delivery", async () => {
  expect(await ingest()).toEqual({ revision: 1, replayed: false });
  expect(await ingest()).toEqual({ revision: 1, replayed: true });
  expect(await ingest(2)).toEqual({ revision: 1, replayed: true });
  await expect(ingest(2, [resource("different")])).rejects.toThrow(
    "sequence reused",
  );
  expect(await ingest(3, [])).toEqual({ revision: 2, replayed: false });
  reopen();
  await expect(ingest(2)).rejects.toThrow("stale");
  expect(await store.api.getResource({ ...resource(), ...local })).toBeNull();
  expect(
    (await store.writerState({ project_id, chat_path }))?.source_sequence,
  ).toBe(3);
  const newWriter = {
    project_id,
    chat_path,
    registration_id: "writer-2",
    expected_epoch: epoch,
  };
  const next = await store.registerSource(newWriter);
  expect(await store.registerSource(newWriter)).toEqual(next);
  await expect(ingest(4)).rejects.toThrow("epoch");
  await expect(
    store.registerSource({ ...newWriter, registration_id: "writer-3" }),
  ).rejects.toThrow("epoch changed");
  epoch = next.epoch;
  expect(await ingest(1, [])).toEqual({ revision: 2, replayed: true });
});

test("copy or relocation conflicts never retarget a durable identity", async () => {
  await ingest();
  const otherPath = "/home/user/copy.chat";
  const other = await store.registerSource({
    project_id,
    chat_path: otherPath,
    registration_id: "other",
    expected_epoch: null,
  });
  const copy = {
    ...snapshot(),
    chat_path: otherPath,
    epoch: other.epoch,
    resources: [resource("thread-a", { chat_path: otherPath })],
  };
  await expect(store.ingest({ snapshot: copy })).rejects.toThrow(
    "another source",
  );
  await ingest(2, []);
  await expect(store.ingest({ snapshot: copy })).rejects.toThrow(
    "another source",
  );
  expect(
    (await store.writerState({ project_id, chat_path: otherPath }))?.sequence,
  ).toBe(0);
});

test("bounded search and keyset paging bind cursors to query and index generation", async () => {
  const items = Array.from({ length: 123 }, (_, i) =>
    resource(String(i).padStart(3, "0"), {
      title: `Geometry topic ${i}`,
      updated_at: Math.floor(i / 2),
    }),
  );
  await ingest(1, items);
  let after: string | undefined;
  const ids: string[] = [];
  do {
    const page = await store.api.listResources({ ...local, limit: 17, after });
    expect(page.items.length).toBeLessThanOrEqual(17);
    ids.push(...page.items.map((item) => item.resource_id));
    after = page.next;
  } while (after);
  expect(new Set(ids).size).toBe(123);
  expect(ids.slice(0, 3)).toEqual(["122", "120", "121"]);
  const first = await store.api.listResources({
    ...local,
    limit: 10,
    search: "geom",
  });
  expect(first.items).toHaveLength(10);
  await expect(
    store.api.listResources({
      ...local,
      limit: 10,
      search: "topic",
      after: first.next,
    }),
  ).rejects.toThrow("does not match query");
  await expect(
    store.api.listResources({ ...local, after: "not-a-cursor" }),
  ).rejects.toThrow("cursor");
  await ingest(
    2,
    items.map((item) => ({ ...item, title: `Changed ${item.title}` })),
  );
  await expect(
    store.api.listResources({
      ...local,
      limit: 10,
      search: "geom",
      after: first.next,
    }),
  ).rejects.toThrow("restart pagination");
  expect(
    (
      await store.api.listResources({
        ...local,
        search: 'Geometry" OR "missing',
      })
    ).items,
  ).toEqual([]);
});

test("page byte limit provides a continuation without truncating source ingestion", async () => {
  const participants = Array.from(
    { length: 60 },
    (_, i) => `${i}${"x".repeat(180)}`,
  );
  const resources = Array.from({ length: 50 }, (_, i) =>
    resource(`large-${i}`, { participant_ids: participants }),
  );
  await ingest(1, resources);
  const first = await store.api.listResources(local);
  expect(first.items.length).toBeGreaterThan(0);
  expect(first.items.length).toBeLessThan(50);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
    limits.MAX_PAGE_BYTES,
  );
  let count = first.items.length;
  let after = first.next;
  while (after) {
    const page = await store.api.listResources({ ...local, after });
    count += page.items.length;
    after = page.next;
  }
  expect(count).toBe(50);
});

test("kind/person/archive filtering and service-only coverage are honest", async () => {
  await ingestCompleteRelations(1, [
    resource("a", { kind: "artifact", created_by: account_id }),
    resource("b", { participant_ids: [account_id] }),
    resource("c", { archived: true }),
  ]);
  expect(
    (await store.api.listResources({ ...local, person_id: account_id })).items,
  ).toHaveLength(2);
  expect(
    (await store.api.listResources({ ...local, kind: "artifact" })).items.map(
      (item) => item.resource_id,
    ),
  ).toEqual(["a"]);
  expect((await store.api.listResources(local)).items).toHaveLength(2);
  expect(
    (await store.api.listResources({ ...local, include_archived: true })).items,
  ).toHaveLength(3);
  store.setCoverage("indexing", "A bounded service backfill is running.");
  reopen();
  expect(await store.api.listResources(local)).toMatchObject({
    coverage: "indexing",
    coverage_message: expect.stringContaining(
      "A bounded service backfill is running.",
    ),
  });
  expect(() => store.setCoverage("complete" as "partial")).toThrow("coverage");
  await expect(
    store.api.sourcePage({ project_id, host_id: "host" }),
  ).rejects.toThrow("service-local");
  await expect(
    store.api.writerState({ project_id, chat_path, host_id: "host" }),
  ).rejects.toThrow("service-local");
});

test("invalid or oversized replacements leave the last good snapshot intact", async () => {
  await ingest();
  for (const bad of [
    snapshot(2, [resource(), resource()]),
    snapshot(2, [resource("bad", { title: "x".repeat(513) })]),
    snapshot(2, [resource("bad", { chat_path: "/elsewhere.chat" })]),
    snapshot(2, [resource("bad", { activity: -1 })]),
    snapshot(
      2,
      Array.from({ length: 5001 }, (_, i) => resource(`${i}`)),
    ),
    { ...snapshot(2), transcript: "x".repeat(2 * 1024 * 1024) },
    { ...snapshot(2), chat_path: "/home/user/../discussion.chat" },
  ])
    await expect(store.ingest({ snapshot: bad })).rejects.toThrow();
  expect(
    (await store.api.listResources(local)).items.map(
      (item) => item.resource_id,
    ),
  ).toEqual(["thread-a"]);
  expect((await store.writerState({ project_id, chat_path }))?.sequence).toBe(
    1,
  );
  await ingest(2, [
    {
      ...resource(),
      personal: {
        collected: true,
        following: true,
        muted: true,
        read_through: 999,
      },
    },
  ]);
  expect(
    (await store.api.getResource({ ...resource(), ...local }))?.personal
      ?.following,
  ).toBe(false);
});

test("known-source reconciliation is bounded and survives restart", async () => {
  for (let i = 0; i < 104; i++)
    await store.registerSource({
      project_id,
      chat_path: `/home/user/source-${String(i).padStart(3, "0")}.chat`,
      registration_id: `${i}`,
      expected_epoch: null,
    });
  reopen();
  const first = await store.sourcePage({ project_id });
  expect(first.paths).toHaveLength(100);
  const second = await store.sourcePage({ project_id, after: first.next });
  expect(second.paths).toHaveLength(5);
  expect(second.next).toBeUndefined();
});

test("revision polling observes source, personal and coverage changes across restart", async () => {
  const initial = await store.api.check(local);
  expect(initial).toMatchObject({ reset: true, poll_after_ms: 5000 });
  const token = JSON.parse(
    Buffer.from(initial.revision, "base64url").toString(),
  );
  expect(token).toMatchObject({ v: 1, account_id, project_id });
  expect(token.expires).toBeLessThanOrEqual(Date.now() + 30_000);
  expect(token.expires).toBeGreaterThan(Date.now());
  expect(
    await store.api.check({ ...local, since: initial.revision }),
  ).toMatchObject({ reset: false });
  await ingest();
  expect(
    await store.api.check({ ...local, since: initial.revision }),
  ).toMatchObject({ reset: true });
  const page = await store.api.listResources(local);
  reopen();
  expect(
    await store.api.check({ ...local, since: page.revision }),
  ).toMatchObject({ reset: false });
  await ingest(2);
  expect(
    await store.api.check({ ...local, since: page.revision }),
  ).toMatchObject({ reset: false });
  await store.api.setPersonalState({
    ...resource(),
    ...local,
    patch: { following: true },
  });
  expect(
    await store.api.check({ ...local, since: page.revision }),
  ).toMatchObject({ reset: true });
  const personal = await store.api.check(local);
  store.setCoverage("indexing", "Rebuilding service metadata.");
  expect(
    await store.api.check({ ...local, since: personal.revision }),
  ).toMatchObject({ reset: true });
  const status = await store.api.check(local);
  store.setCoverage("indexing", "Rebuilding service metadata.");
  expect(
    await store.api.check({ ...local, since: status.revision }),
  ).toMatchObject({ reset: false });
  await ingest(3, []);
  expect(
    await store.api.check({ ...local, since: status.revision }),
  ).toMatchObject({ reset: true });
});

test("selected-project fallback searches shared titles only and rejects personal scopes", async () => {
  await ingest();
  await store.api.setPersonalState({
    ...resource(),
    ...local,
    patch: { alias: "secretalias" },
  });
  expect(
    (await store.api.listResources({ ...local, search: "secretalias" })).items,
  ).toHaveLength(1);
  expect(
    (await store.api.listProjectResources({ ...local, search: "secretalias" }))
      .items,
  ).toEqual([]);
  const page = await store.api.listProjectResources({
    ...local,
    search: "geom",
  });
  expect(page.items).toHaveLength(1);
  expect(page.items[0].personal?.alias).toBe("secretalias");
  expect(
    await store.api.check({ ...local, since: page.revision }),
  ).toMatchObject({ reset: false });
  await expect(
    store.api.listProjectResources({ ...local, scope: "collected" } as any),
  ).rejects.toThrow("personal scopes");
});

test("explicit inventory requests are durable metadata-only and idempotent", async () => {
  const path = "/home/user/explicit.chat";
  const files = readdirSync(directory);
  expect(await store.api.requestSource({ ...local, chat_path: path })).toEqual({
    requested: true,
  });
  expect(await store.api.requestSource({ ...local, chat_path: path })).toEqual({
    requested: true,
  });
  reopen();
  expect((await store.sourcePage({ project_id })).paths).toContain(path);
  expect(await store.writerState({ project_id, chat_path: path })).toBeNull();
  expect((await store.api.listResources(local)).items).toEqual([]);
  expect(readdirSync(directory)).toEqual(files);
  await expect(
    store.api.requestSource({
      ...local,
      chat_path: "/home/user/../not-canonical.chat",
    }),
  ).rejects.toThrow("canonical");
});

test("local checkpoint pages include retained activity floors and bind cursors to source epochs", async () => {
  await ingest(
    1,
    Array.from({ length: 125 }, (_, i) =>
      resource(`thread-${String(i).padStart(3, "0")}`, { activity: i + 1 }),
    ),
  );
  await ingest(2, []);
  const first = await store.checkpointPage({ project_id, chat_path });
  expect(first.items).toHaveLength(100);
  const second = await store.checkpointPage({
    project_id,
    chat_path,
    after: first.next,
  });
  expect(second.items).toHaveLength(25);
  expect(second.next).toBeUndefined();
  expect(first.items[0].activity).toBe(1);
  expect(second.items[24].activity).toBe(125);
  await store.registerSource({
    project_id,
    chat_path,
    expected_epoch: epoch,
    registration_id: "recovery-writer",
  });
  await expect(
    store.checkpointPage({ project_id, chat_path, after: first.next }),
  ).rejects.toThrow("restart");
  await expect(
    store.api.checkpointPage({ project_id, chat_path, host_id: "remote" }),
  ).rejects.toThrow("service-local");
});

test("revision tokens expire, reject foreign scopes and reset malformed input", async () => {
  const now = Date.now();
  const clock = jest.spyOn(Date, "now").mockReturnValue(now);
  const { revision } = await store.api.check(local);
  const decode = () =>
    JSON.parse(Buffer.from(revision, "base64url").toString());
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const since of [
    "broken",
    "x".repeat(1025),
    encode(null),
    encode({ ...decode(), account_id: "stranger" }),
    encode({ ...decode(), project_id: "another-project" }),
    encode({ ...decode(), expires: now + 30_001 }),
    encode({ ...decode(), expires: "never" }),
  ])
    expect(await store.api.check({ ...local, since })).toMatchObject({
      reset: true,
    });
  clock.mockReturnValue(now + 29_999);
  expect(await store.api.check({ ...local, since: revision })).toMatchObject({
    reset: false,
  });
  clock.mockReturnValue(now + 30_000);
  expect(await store.api.check({ ...local, since: revision })).toMatchObject({
    reset: true,
  });
});

test("page revision is captured before querying, not after result assembly", async () => {
  await ingest();
  const original = (store as any).resource.bind(store);
  const assemble = jest
    .spyOn(store as any, "resource")
    .mockImplementationOnce((...args: any[]) => {
      const result = original(...args);
      // Simulate a mutation after the page read but before its response is built.
      (store as any).changed();
      return result;
    });
  const page = await store.api.listResources(local);
  assemble.mockRestore();
  expect(
    await store.api.check({ ...local, since: page.revision }),
  ).toMatchObject({ reset: true });
  for (const page of [
    await store.api.listPeople(local),
    await store.api.listProjects(local),
  ])
    expect(
      await store.api.check({ ...local, since: page.revision }),
    ).toMatchObject({ reset: false });
});

test("large participant summaries preserve the room and disclose incomplete filters durably", async () => {
  const participants = Array.from({ length: 64 }, (_, i) => `participant-${i}`);
  const large = resource("large", {
    participant_ids: participants,
    participant_count: 1000,
    participants_truncated: true,
  });
  await store.ingest({
    snapshot: {
      ...snapshot(1, [large]),
      coverage: "partial",
      coverage_message: "Participant summary excludes additional room members.",
    },
  });
  reopen();
  const page = await store.api.listResources(local);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    participant_count: 1000,
    participants_truncated: true,
  });
  expect(page.items[0].participant_ids).toHaveLength(64);
  expect(page.coverage_message).toContain("Participant summary excludes");
  await ingest(2, [large]);
  expect((await store.api.listResources(local)).coverage_message).toContain(
    "summaries are incomplete",
  );
  await ingest(3, [resource("large")]);
  expect((await store.api.listResources(local)).coverage_message).not.toContain(
    "summaries are incomplete",
  );
  expect(
    await store.api.check({ ...local, since: page.revision }),
  ).toMatchObject({ reset: true });
});

test.each([
  { participant_count: -1 },
  { participant_count: 0, participant_ids: ["human"] },
  { participant_count: 1.5 },
  { participants_truncated: "yes" },
  { participant_ids: Array.from({ length: 65 }, (_, i) => `${i}`) },
])(
  "invalid participant summary is rejected without losing existing metadata: %j",
  async (patch) => {
    await ingest();
    await expect(ingest(2, [resource("bad", patch as any)])).rejects.toThrow(
      "participant",
    );
    expect(
      (await store.api.listResources(local)).items.map(
        (item) => item.resource_id,
      ),
    ).toEqual(["thread-a"]);
  },
);

test.each([
  { alias: "bad alias" },
  { following: "yes" },
  { read_through: -1 },
  { read_through: 0.5 },
  { alias: null },
  { admin: true },
])("rejects invalid personal state %j", async (patch) => {
  await ingest();
  await expect(
    store.api.setPersonalState({
      ...resource(),
      ...local,
      patch: patch as any,
    }),
  ).rejects.toThrow("invalid collaborators");
});
