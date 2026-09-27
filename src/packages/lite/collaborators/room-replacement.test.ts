import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CollaborationRoomReplacementRequest } from "@cocalc/util/collaboration-room-replacement";
import type { CollaborationRoom } from "@cocalc/util/collaborators";
import { LiteCollaborators } from "./index";
import { createCollaborationRelationSet } from "@cocalc/util/collaboration-relations-codec";

const project_id = "11111111-1111-4111-8111-111111111111";
const account_id = "22222222-2222-4222-8222-222222222222";
const identity = { project_id, account_id };
let directory: string;
let store: LiteCollaborators;
let room: CollaborationRoom;
let epoch: string;
let request: CollaborationRoomReplacementRequest;
const options = () => ({
  filename: join(directory, "owner.sqlite"),
  ...identity,
  room_home: directory,
  room_path: join(directory, "old.chat"),
  isEnabled: () => true,
});
const input = (intent = request, source_epoch: string | null = epoch) => ({
  project_id,
  requesting_account_id: account_id,
  request: intent,
  absence: {
    status: "missing" as const,
    project_id,
    requesting_account_id: account_id,
    host_id: project_id,
    request_id: intent.request_id,
    room_id: intent.expected_room_id,
    chat_path: intent.expected_chat_path,
    source_epoch,
  },
});
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "lite-room-replacement-"));
  store = new LiteCollaborators(options());
  room = await store.ensureRoom({ ...identity, request_id: randomUUID() });
  await store.markRoomInitialized({
    ...room,
    requesting_account_id: account_id,
  });
  ({ epoch } = await store.registerSource({
    ...room,
    registration_id: randomUUID(),
    expected_epoch: null,
  }));
  request = {
    version: 1,
    project_id,
    request_id: randomUUID(),
    expected_room_id: room.room_id,
    expected_chat_path: room.chat_path,
  };
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("owner CAS retires indexed resources, retains floors and replays across restart", async () => {
  const resource = {
    project_id,
    chat_path: room.chat_path,
    kind: "conversation" as const,
    resource_id: randomUUID(),
    thread_id: randomUUID(),
    title: "Historical discussion",
    created_at: 1,
    updated_at: 2,
    activity: 9,
    participant_ids: [],
  };
  const snapshot = {
    project_id,
    chat_path: room.chat_path,
    epoch,
    sequence: 1,
    resources: [resource],
  };
  await store.ingest({ snapshot });
  expect(
    await store.api.getResource({ ...resource, account_id }),
  ).not.toBeNull();
  const first = await store.replaceRoom(input());
  expect(first.outcome).toBe("pending");
  if (first.outcome === "superseded") throw Error("unexpected supersession");
  expect(first.room.chat_path).toBe(
    join(directory, ".cocalc", "conversations", `${first.room.room_id}.chat`),
  );
  expect(await store.api.getResource({ ...resource, account_id })).toBeNull();
  expect(await store.writerState(room)).toMatchObject({
    retired_room_id: room.room_id,
  });
  expect((await store.sourcePage({ project_id })).paths).not.toContain(
    room.chat_path,
  );
  await expect(
    store.ingest({ snapshot: { ...snapshot, sequence: 2 } }),
  ).rejects.toThrow("retired");
  await expect(
    store.registerSource({
      ...room,
      expected_epoch: epoch,
      registration_id: randomUUID(),
    }),
  ).rejects.toThrow("retired");
  await expect(
    store.api.requestSource({ ...identity, chat_path: room.chat_path }),
  ).rejects.toThrow("retired");
  await expect(
    store.markRoomInitialized({ ...room, requesting_account_id: account_id }),
  ).rejects.toThrow("changed");
  store.close();
  store = new LiteCollaborators(options());
  expect(await store.replaceRoom({ ...input(), absence: undefined })).toEqual(
    first,
  );
  await expect(store.checkpointPage(room)).rejects.toThrow("retired");
  const observer = new DatabaseSync(options().filename, { readOnly: true });
  try {
    const row = observer
      .prepare(
        "SELECT deleted,metadata FROM collaboration_resources WHERE resource_id=?",
      )
      .get(resource.resource_id)!;
    expect(row.deleted).toBe(1);
    expect(JSON.parse(String(row.metadata))).toEqual({ activity: 9 });
  } finally {
    observer.close();
  }
  await store.markRoomInitialized({
    ...first.room,
    requesting_account_id: account_id,
  });
  expect(
    await store.replaceRoom({ ...input(), absence: undefined }),
  ).toMatchObject({ outcome: "ready", room: { initialized: true } });
});

test("retirement releases active and staged relation quota without deleting personal state or unrelated relations", async () => {
  async function publish(
    chat_path: string,
    sourceEpoch: string,
    resource_id: string,
    sequence = 1,
    commit = true,
  ) {
    const resource = {
      project_id,
      chat_path,
      kind: "conversation" as const,
      resource_id,
      thread_id: resource_id,
      title: resource_id,
      created_at: 1,
      updated_at: 2,
      activity: 1,
      participant_ids: [account_id],
    };
    const snapshot = {
      project_id,
      chat_path,
      epoch: sourceEpoch,
      sequence,
      resources: [resource],
    };
    const relations = await createCollaborationRelationSet(
      { project_id, chat_path, epoch: sourceEpoch, sequence },
      [
        {
          kind: "participant",
          source: {
            kind: "conversation",
            resource_id,
            thread_id: resource_id,
          },
          account_id,
        },
      ],
      async (page) => {
        await store.stageRelationPage({ page });
      },
    );
    if (commit) await store.ingest({ snapshot: { ...snapshot, relations } });
    return resource;
  }
  const resource = await publish(room.chat_path, epoch, "old-thread");
  await publish(room.chat_path, epoch, "old-thread", 2, false);
  const otherPath = join(directory, "unrelated.chat");
  const other = await store.registerSource({
    project_id,
    chat_path: otherPath,
    expected_epoch: null,
    registration_id: randomUUID(),
  });
  await publish(otherPath, other.epoch, "other-thread");
  await store.api.setPersonalState({
    ...resource,
    account_id,
    patch: { following: true, read_through: 1 },
  });
  const observer = new DatabaseSync(options().filename, { readOnly: true });
  try {
    const personal = observer
      .prepare("SELECT * FROM collaboration_personal ORDER BY resource_key")
      .all();
    expect(
      observer
        .prepare(
          "SELECT count(*) AS n FROM collaboration_relation_sets WHERE chat_path=?",
        )
        .get(room.chat_path)!.n,
    ).toBe(2);
    const otherRows = observer
      .prepare("SELECT * FROM collaboration_relation_sets WHERE chat_path=?")
      .all(otherPath);
    expect(
      Number(
        observer
          .prepare(
            "SELECT sum(stored_bytes) AS n FROM collaboration_relation_sets WHERE chat_path=?",
          )
          .get(room.chat_path)!.n,
      ),
    ).toBeGreaterThan(0);
    await store.replaceRoom(input());
    expect(
      observer
        .prepare("SELECT * FROM collaboration_relation_sets WHERE chat_path=?")
        .all(room.chat_path),
    ).toEqual([]);
    expect(
      observer
        .prepare(
          "SELECT * FROM collaboration_relation_active WHERE chat_path=?",
        )
        .all(room.chat_path),
    ).toEqual([]);
    for (const suffix of ["edges", "bindings", "pages"])
      expect(
        observer
          .prepare(
            `SELECT count(*) AS n FROM collaboration_relation_${suffix} WHERE set_key NOT IN (SELECT set_key FROM collaboration_relation_sets)`,
          )
          .get()!.n,
      ).toBe(0);
    expect(
      observer
        .prepare("SELECT * FROM collaboration_relation_sets WHERE chat_path=?")
        .all(otherPath),
    ).toEqual(otherRows);
    expect(
      observer
        .prepare("SELECT * FROM collaboration_personal ORDER BY resource_key")
        .all(),
    ).toEqual(personal);
    expect(
      observer
        .prepare("SELECT count(*) AS n FROM collaboration_room_replacements")
        .get()!.n,
    ).toBe(1);
    expect(
      observer
        .prepare(
          "SELECT count(*) AS n FROM collaboration_resources WHERE chat_path=? AND deleted=1",
        )
        .get(room.chat_path)!.n,
    ).toBe(1);
    await expect(
      publish(room.chat_path, epoch, "old-thread", 3, false),
    ).rejects.toThrow("retired");
  } finally {
    observer.close();
  }
});

test("invalid evidence and foreign humans leave the original room intact", async () => {
  for (const bad of [
    { ...input(), absence: undefined },
    input(request, randomUUID()),
    { ...input(), requesting_account_id: randomUUID() },
    { ...input(), absence: { ...input().absence, host_id: randomUUID() } },
  ])
    await expect(store.replaceRoom(bad)).rejects.toThrow();
  expect(await store.registeredRoom(identity)).toMatchObject({
    room_id: room.room_id,
    initialized: true,
  });
  expect(await store.writerState(room)).toMatchObject({ epoch });
});

test("concurrent retries converge and later replacements supersede without reviving old identity", async () => {
  const [first, retry] = await Promise.all([
    store.replaceRoom(input()),
    store.replaceRoom(input()),
  ]);
  expect(first).toEqual(retry);
  if (first.outcome === "superseded") throw Error("unexpected supersession");
  await store.markRoomInitialized({
    ...first.room,
    requesting_account_id: account_id,
  });
  const nextRequest = {
    ...request,
    request_id: randomUUID(),
    expected_room_id: first.room.room_id,
    expected_chat_path: first.room.chat_path,
  };
  const second = await store.replaceRoom(input(nextRequest, null));
  expect(second.outcome).toBe("pending");
  expect(await store.replaceRoom({ ...input(), absence: undefined })).toEqual({
    outcome: "superseded",
    operation_id: first.operation_id,
    replacement_room_id: first.room.room_id,
  });
});

test.each(["from", "to"])(
  "relocation cannot revive a retired %s path",
  async (direction) => {
    await store.replaceRoom(input());
    await expect(
      store.relocateSource({
        project_id,
        operation_id: randomUUID(),
        expected_epoch: epoch,
        expected_destination_epoch: null,
        from_chat_path:
          direction === "from" ? room.chat_path : join(directory, "other.chat"),
        to_chat_path:
          direction === "to" ? room.chat_path : join(directory, "other.chat"),
      }),
    ).rejects.toThrow("retired");
  },
);

test("all 32 receipts remain replayable at capacity; the 33rd cannot change the room", async () => {
  const initial = input();
  let first: Awaited<ReturnType<typeof store.replaceRoom>> | undefined;
  for (let i = 0; i < 32; i++) {
    const result = await store.replaceRoom(
      input(request, i === 0 ? epoch : null),
    );
    first ??= result;
    if (result.outcome === "superseded") throw Error("unexpected supersession");
    await store.markRoomInitialized({
      ...result.room,
      requesting_account_id: account_id,
    });
    request = {
      ...request,
      request_id: randomUUID(),
      expected_room_id: result.room.room_id,
      expected_chat_path: result.room.chat_path,
    };
  }
  await expect(store.replaceRoom(input(request, null))).rejects.toThrow(
    /capacity|limit/,
  );
  expect(await store.registeredRoom(identity)).toMatchObject({
    room_id: request.expected_room_id,
  });
  expect(
    await store.replaceRoom({ ...initial, absence: undefined }),
  ).toMatchObject({ outcome: "superseded", operation_id: first!.operation_id });
});
