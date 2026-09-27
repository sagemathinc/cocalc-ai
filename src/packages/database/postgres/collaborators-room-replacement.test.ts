import { randomUUID } from "node:crypto";
jest.mock("../pool", () => jest.requireActual("@cocalc/database/pool"));
import "@cocalc/util/db-schema/collaborators-workspace";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  replaceCollaborationRoom,
  getCollaborationRoom,
} from "./collaborators-room-replacement";
import {
  ensureCollaborationRoom,
  markCollaborationRoomInitialized,
  registerCollaborationSource,
  ingestCollaborationSnapshot,
  compactCollaborationProject,
  collaborationWriterState,
  collaborationRoomForHost,
  collaborationSourcePage,
  getOwnedCollaborationResource,
} from "./collaborators-owner";
import {
  entryKey,
  sourceKey,
  syncCollaboratorsSchema,
} from "./collaborators-common";
import type { CollaborationRoomReplacementHostRequest } from "@cocalc/util/collaboration-room-replacement";

const authority = { owning_bay_id: "replacement-test", host_id: randomUUID() };
beforeAll(async () => {
  await initEphemeralDatabase({});
  await syncCollaboratorsSchema();
}, 60_000);
afterAll(async () => {
  await testCleanup();
});
async function fixture() {
  const project_id = randomUUID(),
    account_id = randomUUID(),
    collaborator = randomUUID();
  await getPool().query(
    "INSERT INTO projects(project_id,host_id,owning_bay_id,users) VALUES($1,$2,$3,$4::jsonb)",
    [
      project_id,
      authority.host_id,
      authority.owning_bay_id,
      JSON.stringify({
        [account_id]: { group: "owner" },
        [collaborator]: { group: "collaborator" },
      }),
    ],
  );
  const room = await ensureCollaborationRoom(
    project_id,
    account_id,
    randomUUID(),
    authority,
  );
  await markCollaborationRoomInitialized(
    { ...room, requesting_account_id: account_id },
    authority,
  );
  const epoch = await registerCollaborationSource(
    room,
    authority,
    null,
    randomUUID(),
  );
  const resource = {
    ...room,
    kind: "conversation" as const,
    resource_id: randomUUID(),
    thread_id: randomUUID(),
    title: "Private old title",
    participant_ids: [account_id],
    activity: 3,
    created_at: 1,
    updated_at: 3,
  };
  await ingestCollaborationSnapshot(
    { ...room, epoch, sequence: 1, resources: [resource] },
    authority,
  );
  const request_id = randomUUID();
  const opts: CollaborationRoomReplacementHostRequest = {
    project_id,
    requesting_account_id: account_id,
    request: {
      version: 1,
      project_id,
      request_id,
      expected_room_id: room.room_id,
      expected_chat_path: room.chat_path,
    },
    absence: {
      status: "missing",
      project_id,
      requesting_account_id: account_id,
      host_id: authority.host_id,
      request_id,
      room_id: room.room_id,
      chat_path: room.chat_path,
      source_epoch: epoch,
    },
  };
  return { project_id, account_id, collaborator, room, epoch, resource, opts };
}

test("owner commit atomically switches identity, retires source and clears catalog metadata", async () => {
  const f = await fixture();
  const result = await replaceCollaborationRoom(f.opts, authority);
  expect(result.outcome).toBe("pending");
  if (result.outcome === "superseded") throw Error("unexpected supersession");
  expect(
    await getCollaborationRoom(f.project_id, f.account_id, authority),
  ).toEqual(result.room);
  expect(result.room.room_id).not.toBe(f.room.room_id);
  expect(result.room.chat_path).not.toBe(f.room.chat_path);
  expect(
    await collaborationRoomForHost(f.project_id, f.collaborator, authority),
  ).toMatchObject({
    ...result.room,
    retired_rooms: [{ room_id: f.room.room_id, chat_path: f.room.chat_path }],
  });
  expect(
    await getCollaborationRoom(f.project_id, f.account_id, authority),
  ).not.toHaveProperty("retired_rooms");
  const row = (
    await getPool().query(
      "SELECT * FROM collaboration_catalog WHERE entry_key=$1",
      [entryKey(f.resource)],
    )
  ).rows[0];
  expect(row.metadata).toBeNull();
  expect(row.deleted_at).not.toBeNull();
  expect(Number(row.activity_floor)).toBe(3);
  expect(
    (await collaborationWriterState(f.room, authority, true))?.retired_room_id,
  ).toBe(f.room.room_id);
  expect(
    (await collaborationSourcePage(f.project_id, authority)).paths,
  ).not.toContain(f.room.chat_path);
  expect(
    await getOwnedCollaborationResource(f.resource, f.account_id, authority),
  ).toBeNull();
});

test("lost acknowledgement replays pending then initialized state without another revision", async () => {
  const f = await fixture();
  const first = await replaceCollaborationRoom(f.opts, authority);
  const before = (
    await getPool().query(
      "SELECT revision FROM collaboration_projects WHERE project_id=$1",
      [f.project_id],
    )
  ).rows[0].revision;
  expect(
    await replaceCollaborationRoom(
      { ...f.opts, absence: undefined },
      authority,
    ),
  ).toEqual(first);
  if (first.outcome === "superseded") throw Error("unexpected supersession");
  await markCollaborationRoomInitialized(
    { ...first.room, requesting_account_id: f.account_id },
    authority,
  );
  expect(
    await replaceCollaborationRoom(
      { ...f.opts, absence: undefined },
      authority,
    ),
  ).toMatchObject({ outcome: "ready", operation_id: first.operation_id });
  expect(
    (
      await getPool().query(
        "SELECT revision FROM collaboration_projects WHERE project_id=$1",
        [f.project_id],
      )
    ).rows[0].revision,
  ).toBe(before);
});

test("stale source registration, ingest and room initialization cannot revive the old room", async () => {
  const f = await fixture();
  await replaceCollaborationRoom(f.opts, authority);
  const state = await collaborationWriterState(f.room, authority);
  await expect(
    registerCollaborationSource(f.room, authority, state!.epoch, randomUUID()),
  ).rejects.toThrow("retired");
  await expect(
    ingestCollaborationSnapshot(
      { ...f.room, epoch: state!.epoch, sequence: 1, resources: [f.resource] },
      authority,
    ),
  ).rejects.toThrow("stale");
  await expect(
    markCollaborationRoomInitialized(
      { ...f.room, requesting_account_id: f.account_id },
      authority,
    ),
  ).rejects.toThrow("changed");
  await getPool().query(
    "UPDATE collaboration_catalog SET deleted_at=now()-interval '30 days' WHERE project_id=$1",
    [f.project_id],
  );
  await compactCollaborationProject(f.project_id, authority);
  expect(
    (
      await getPool().query(
        "SELECT count(*) AS n FROM collaboration_catalog WHERE entry_key=$1",
        [entryKey(f.resource)],
      )
    ).rows[0].n,
  ).toBe("1");
});

test("wrong expected epoch, missing absence and nonowner calls roll back all state", async () => {
  const f = await fixture();
  for (const opts of [
    { ...f.opts, absence: undefined },
    { ...f.opts, absence: { ...f.opts.absence!, source_epoch: randomUUID() } },
    { ...f.opts, requesting_account_id: f.collaborator },
    {
      ...f.opts,
      request: { ...f.opts.request, expected_room_id: randomUUID() },
    },
  ])
    await expect(replaceCollaborationRoom(opts, authority)).rejects.toThrow();
  expect(
    (await getCollaborationRoom(f.project_id, f.account_id, authority))
      ?.room_id,
  ).toBe(f.room.room_id);
  expect(
    (
      await getPool().query(
        "SELECT count(*) AS n FROM collaboration_room_replacements WHERE project_id=$1",
        [f.project_id],
      )
    ).rows[0].n,
  ).toBe("0");
  expect(
    (
      await getPool().query(
        "SELECT retired_room_id FROM collaboration_sources WHERE source_id=$1",
        [sourceKey(f.room)],
      )
    ).rows[0].retired_room_id,
  ).toBeNull();
});

test("same operation converges while competing expected-identity CAS fails", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([
    replaceCollaborationRoom(f.opts, authority),
    replaceCollaborationRoom(f.opts, authority),
  ]);
  expect(a).toEqual(b);
  const request_id = randomUUID();
  await expect(
    replaceCollaborationRoom(
      {
        ...f.opts,
        request: { ...f.opts.request, request_id },
        absence: { ...f.opts.absence!, request_id },
      },
      authority,
    ),
  ).rejects.toThrow("room_changed");
});

test("a fresh host may replay but the former host and removed owner cannot", async () => {
  const f = await fixture();
  const first = await replaceCollaborationRoom(f.opts, authority);
  const next = { ...authority, host_id: randomUUID() };
  await getPool().query("UPDATE projects SET host_id=$2 WHERE project_id=$1", [
    f.project_id,
    next.host_id,
  ]);
  expect(
    await replaceCollaborationRoom({ ...f.opts, absence: undefined }, next),
  ).toEqual(first);
  await expect(replaceCollaborationRoom(f.opts, authority)).rejects.toThrow();
  await getPool().query("UPDATE projects SET users='{}' WHERE project_id=$1", [
    f.project_id,
  ]);
  await expect(replaceCollaborationRoom(f.opts, next)).rejects.toThrow(
    "access_denied",
  );
});

test("replaying a replaced replacement is superseded, never another pointer write", async () => {
  const f = await fixture();
  const first = await replaceCollaborationRoom(f.opts, authority);
  if (first.outcome === "superseded") throw Error("unexpected supersession");
  await markCollaborationRoomInitialized(
    { ...first.room, requesting_account_id: f.account_id },
    authority,
  );
  const request_id = randomUUID();
  const second = await replaceCollaborationRoom(
    {
      ...f.opts,
      request: {
        ...f.opts.request,
        request_id,
        expected_room_id: first.room.room_id,
        expected_chat_path: first.room.chat_path,
      },
      absence: {
        ...f.opts.absence!,
        request_id,
        room_id: first.room.room_id,
        chat_path: first.room.chat_path,
        source_epoch: null,
      },
    },
    authority,
  );
  expect(
    await replaceCollaborationRoom(
      { ...f.opts, absence: undefined },
      authority,
    ),
  ).toEqual({
    outcome: "superseded",
    operation_id: first.operation_id,
    replacement_room_id: first.room.room_id,
  });
  if (second.outcome === "superseded") throw Error("unexpected supersession");
  expect(
    (await getCollaborationRoom(f.project_id, f.account_id, authority))
      ?.room_id,
  ).toBe(second.room.room_id);
});
