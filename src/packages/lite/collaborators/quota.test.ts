/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { LiteCollaborators } from "./index";
import type { CollaborationResource } from "@cocalc/util/collaborators";

jest.mock("./validation", () => ({
  ...jest.requireActual("./validation"),
  MAX_RESOURCES: 2,
  MAX_METADATA_BYTES: 1400,
  MAX_SOURCES: 2,
  MAX_WORK_PER_HOUR: 12,
}));

const project_id = "project";
const account_id = "human";
const chat_path = "/home/user/a.chat";
let store: LiteCollaborators;
let epoch: string;

function resource(resource_id: string): CollaborationResource {
  return {
    project_id,
    chat_path,
    resource_id,
    kind: "conversation",
    thread_id: resource_id,
    title: "Title",
    participant_ids: [],
    activity: 1,
    created_at: 1,
    updated_at: 1,
  };
}

async function ingest(sequence: number, resources: CollaborationResource[]) {
  return store.ingest({
    snapshot: { project_id, chat_path, epoch, sequence, resources },
  });
}

beforeEach(async () => {
  store = new LiteCollaborators({
    filename: ":memory:",
    project_id,
    account_id,
    isEnabled: () => true,
  });
  ({ epoch } = await store.registerSource({
    project_id,
    chat_path,
    registration_id: "first",
    expected_epoch: null,
  }));
});

afterEach(() => store.close());

test("source capacity is bounded without evicting writer fences", async () => {
  await store.registerSource({
    project_id,
    chat_path: "/home/user/b.chat",
    registration_id: "second",
    expected_epoch: null,
  });
  await expect(
    store.registerSource({
      project_id,
      chat_path: "/home/user/c.chat",
      registration_id: "third",
      expected_epoch: null,
    }),
  ).rejects.toThrow("source limit");
  expect((await store.sourcePage({ project_id })).paths).toHaveLength(2);
});

test("resource quota retains tombstones and rolls back an entire source replacement", async () => {
  await ingest(1, [resource("one"), resource("two")]);
  await expect(ingest(2, [resource("three")])).rejects.toThrow(
    "retention limit",
  );
  expect(
    (await store.listResources({ account_id })).items.map(
      (item) => item.resource_id,
    ),
  ).toEqual(["one", "two"]);
  expect((await store.writerState({ project_id, chat_path }))?.sequence).toBe(
    1,
  );
  await ingest(2, []);
  await expect(ingest(3, [resource("three")])).rejects.toThrow(
    "retention limit",
  );
});

test("byte quota failure cannot advance sequence or overwrite good metadata", async () => {
  await ingest(1, [resource("one"), resource("two")]);
  await expect(
    ingest(2, [
      { ...resource("one"), title: "x".repeat(512) },
      { ...resource("two"), title: "y".repeat(512) },
    ]),
  ).rejects.toThrow("retention limit");
  expect(
    (await store.getResource({ ...resource("one"), account_id }))?.title,
  ).toBe("Title");
  expect((await store.writerState({ project_id, chat_path }))?.sequence).toBe(
    1,
  );
});

test("work budget rejects mutations atomically, while identical replay is free", async () => {
  await ingest(1, [resource("one")]);
  for (let i = 2; i <= 6; i++)
    await ingest(i, [{ ...resource("one"), title: `${i}` }]);
  expect(await ingest(7, [{ ...resource("one"), title: "6" }])).toEqual({
    revision: 6,
    replayed: true,
  });
  await expect(
    ingest(8, [{ ...resource("one"), title: "blocked" }]),
  ).rejects.toThrow("mutation budget");
  expect((await store.writerState({ project_id, chat_path }))?.sequence).toBe(
    7,
  );
});
