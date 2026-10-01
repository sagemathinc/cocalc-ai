/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCollaborators } from "./index";
import type { CollaborationResource } from "@cocalc/util/collaborators";

const project_id = "11111111-1111-4111-8111-111111111111";
const account_id = "22222222-2222-4222-8222-222222222222";
const from_chat_path = "/home/user/source.chat";
const to_chat_path = "/home/user/moved.chat";
const resource: CollaborationResource = {
  project_id,
  chat_path: from_chat_path,
  kind: "conversation",
  resource_id: "thread",
  thread_id: "thread",
  title: "Seminar",
  participant_ids: [account_id],
  created_at: 1,
  updated_at: 2,
  activity: 3,
};
let store: LiteCollaborators;
let directory: string;
let filename: string;
let epoch: string;
const options = () => ({
  filename,
  project_id,
  account_id,
  isEnabled: () => true,
  room_path: from_chat_path,
});
const request = () => ({
  project_id,
  from_chat_path,
  to_chat_path,
  operation_id: "move-1",
  expected_epoch: epoch,
  expected_destination_epoch: null,
});
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-move-"));
  filename = join(directory, "catalog.sqlite");
  store = new LiteCollaborators(options());
  ({ epoch } = await store.registerSource({
    project_id,
    chat_path: from_chat_path,
    registration_id: "writer",
    expected_epoch: null,
  }));
  await store.ingest({
    snapshot: {
      project_id,
      chat_path: from_chat_path,
      epoch,
      sequence: 1,
      resources: [{ ...resource, activity: 0 }],
    },
  });
  await store.ingest({
    snapshot: {
      project_id,
      chat_path: from_chat_path,
      epoch,
      sequence: 2,
      resources: [resource],
    },
  });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("move preserves stable target, personal state, room guard and cursor invalidation across retry/restart", async () => {
  const room = await store.ensureRoom({
    project_id,
    account_id,
    request_id: "room",
  });
  await store.markRoomInitialized({
    ...room,
    requesting_account_id: account_id,
  });
  await store.api.setPersonalState({
    ...resource,
    account_id,
    patch: {
      alias: "seminar",
      collected: true,
      following: true,
      read_through: 2,
    },
  });
  const page = await store.api.listResources({ account_id });
  const moved = await store.relocateSource(request());
  store.close();
  store = new LiteCollaborators(options());
  expect(await store.relocateSource(request())).toEqual(moved);
  expect(
    await store.api.getResource({ ...resource, account_id }),
  ).toMatchObject({
    chat_path: to_chat_path,
    activity: 3,
    personal: {
      alias: "seminar",
      collected: true,
      following: true,
      read_through: 2,
    },
  });
  expect(await store.registeredRoom({ project_id, account_id })).toMatchObject({
    room_id: room.room_id,
    chat_path: to_chat_path,
    initialized: true,
  });
  expect(
    await store.api.check({ account_id, since: page.revision }),
  ).toMatchObject({ reset: true });
  expect((await store.sourcePage({ project_id })).paths).toEqual([
    to_chat_path,
  ]);
  await expect(
    store.ingest({
      snapshot: {
        project_id,
        chat_path: from_chat_path,
        epoch,
        sequence: 2,
        resources: [resource],
      },
    }),
  ).rejects.toThrow("relocated");
  const old = await store.writerState({
    project_id,
    chat_path: from_chat_path,
  });
  await expect(
    store.registerSource({
      project_id,
      chat_path: from_chat_path,
      registration_id: "stale",
      expected_epoch: old!.epoch,
    }),
  ).rejects.toThrow("relocated");
  await store.ingest({
    snapshot: {
      project_id,
      chat_path: to_chat_path,
      epoch: moved.epoch,
      sequence: 1,
      resources: [{ ...resource, chat_path: to_chat_path }],
    },
  });
  expect(
    (await store.api.getResource({ ...resource, account_id }))?.personal?.alias,
  ).toBe("seminar");
});

test("operation receipts bind exact inputs and CAS rejects occupied or stale destinations", async () => {
  await expect(
    store.relocateSource({ ...request(), expected_epoch: "stale" }),
  ).rejects.toThrow("epoch");
  await expect(
    store.relocateSource({
      ...request(),
      expected_destination_epoch: "not-empty",
    }),
  ).rejects.toThrow("destination epoch");
  await store.relocateSource(request());
  await expect(
    store.relocateSource({
      ...request(),
      to_chat_path: "/home/user/elsewhere.chat",
    }),
  ).rejects.toThrow("reused");
  await expect(
    store.relocateSource({ ...request(), project_id: "foreign" }),
  ).rejects.toThrow("project");
  const current = await store.writerState({
    project_id,
    chat_path: to_chat_path,
  });
  const occupied = await store.registerSource({
    project_id,
    chat_path: "/home/user/occupied.chat",
    registration_id: "occupied",
    expected_epoch: null,
  });
  await expect(
    store.relocateSource({
      ...request(),
      operation_id: "move-2",
      from_chat_path: to_chat_path,
      to_chat_path: "/home/user/occupied.chat",
      expected_epoch: current!.epoch,
      expected_destination_epoch: occupied.epoch,
    }),
  ).rejects.toThrow("already registered");
});

test("moving back to an old locator fences both generations", async () => {
  const first = await store.relocateSource(request());
  const old = await store.writerState({
    project_id,
    chat_path: from_chat_path,
  });
  const movedBack = await store.relocateSource({
    ...request(),
    operation_id: "move-back",
    from_chat_path: to_chat_path,
    to_chat_path: from_chat_path,
    expected_epoch: first.epoch,
    expected_destination_epoch: old!.epoch,
  });
  expect(movedBack.epoch).not.toBe(epoch);
  expect((await store.sourcePage({ project_id })).paths).toEqual([
    from_chat_path,
  ]);
  expect(
    (await store.api.getResource({ ...resource, account_id }))?.chat_path,
  ).toBe(from_chat_path);
  await expect(
    store.ingest({
      snapshot: {
        project_id,
        chat_path: from_chat_path,
        epoch,
        sequence: 2,
        resources: [resource],
      },
    }),
  ).rejects.toThrow("epoch");
});

test("artifact moves fail atomically until the canonical Library relocation hook is available", async () => {
  await store.ingest({
    snapshot: {
      project_id,
      chat_path: from_chat_path,
      epoch,
      sequence: 3,
      resources: [{ ...resource, kind: "artifact", artifact_id: "native" }],
    },
  });
  const before = await store.api.check({ account_id });
  await expect(store.relocateSource(request())).rejects.toThrow(
    "Library relocation adapter",
  );
  expect(
    await store.api.check({ account_id, since: before.revision }),
  ).toMatchObject({ reset: false });
  expect(
    await store.writerState({ project_id, chat_path: to_chat_path }),
  ).toBeNull();
});

test("remote relocation and initialized-room marking always reject", async () => {
  await expect(
    store.api.relocateSource({ ...request(), host_id: "claimed-host" }),
  ).rejects.toThrow("service-local");
  await expect(
    store.api.markRoomInitialized({
      project_id,
      host_id: "claimed-host",
      room_id: "room",
      chat_path: from_chat_path,
      requesting_account_id: account_id,
    }),
  ).rejects.toThrow("service-local");
});
