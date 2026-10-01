/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { LiteCollaborators } from "./index";
import type { LocalCollaborationSnapshot } from "./validation";
import type { CollaborationMessageEvent } from "@cocalc/util/collaboration-attention";

const project_id = "11111111-1111-4111-8111-111111111111";
const account_id = "22222222-2222-4222-8222-222222222222";
const foreign = "33333333-3333-4333-8333-333333333333";
let store: LiteCollaborators;
let snapshot: LocalCollaborationSnapshot;
let event: CollaborationMessageEvent;

beforeEach(async () => {
  store = new LiteCollaborators({
    filename: ":memory:",
    project_id,
    account_id,
    isEnabled: () => true,
  });
  const room = await store.ensureRoom({
    project_id,
    account_id,
    request_id: "room",
  });
  const { epoch } = await store.registerSource({
    project_id,
    chat_path: room.chat_path,
    registration_id: "writer",
    expected_epoch: null,
  });
  snapshot = {
    project_id,
    chat_path: room.chat_path,
    epoch,
    sequence: 1,
    resources: [
      {
        project_id,
        chat_path: room.chat_path,
        kind: "conversation",
        resource_id: "thread",
        thread_id: "thread",
        title: "Local conversation",
        participant_ids: [],
        created_at: 1,
        updated_at: 2,
        activity: 1,
      },
    ],
  };
  event = {
    version: 1,
    project_id,
    room_id: room.room_id,
    thread_id: "thread",
    message_id: "message",
    actor_account_id: account_id,
    activity: 1,
    mode: "live",
    mentioned_account_ids: [account_id],
    mention_all: false,
  };
});
afterEach(() => store.close());

test("acknowledged queue hints cannot change snapshot replay identity or an established read boundary", async () => {
  await store.ingest({ snapshot, initialReadFloors: new Map([["thread", 0]]) });
  await expect(store.ingest({ snapshot })).resolves.toMatchObject({
    replayed: true,
  });
  expect(
    (await store.api.getResource({ ...snapshot.resources[0], account_id }))
      ?.personal?.read_through,
  ).toBe(0);
});

test.each(["history", "backfill", "live", "foreign"])(
  "initial conversation boundary distinguishes %s without marking later metadata read",
  async (mode) => {
    const first = {
      ...snapshot,
      resources: [{ ...snapshot.resources[0], activity: 5 }],
      ...(mode === "history"
        ? {}
        : {
            notification_events: [
              {
                ...event,
                activity: 4,
                mode:
                  mode === "backfill"
                    ? ("backfill" as const)
                    : ("live" as const),
                actor_account_id: mode === "foreign" ? foreign : account_id,
              },
            ],
          }),
    };
    await store.ingest({ snapshot: first });
    const expected = mode === "live" ? 3 : 5;
    const target = { ...snapshot.resources[0], account_id };
    expect((await store.api.getResource(target))?.personal?.read_through).toBe(
      expected,
    );
    await store.ingest({
      snapshot: {
        ...snapshot,
        sequence: 2,
        resources: [
          { ...snapshot.resources[0], activity: 10, title: "Repair" },
        ],
      },
    });
    expect((await store.api.getResource(target))?.personal?.read_through).toBe(
      expected,
    );
  },
);

test("self mentions, mention-all, backfill and imported actors cannot invent non-self local attention", async () => {
  for (const patch of [
    {},
    { mention_all: true },
    { actor_account_id: foreign },
    { mode: "backfill" as const },
    { mentioned_account_ids: [foreign] },
  ]) {
    const current = {
      ...snapshot,
      notification_events: [{ ...event, ...patch }],
    };
    await store.ingest({ snapshot: current });
    expect(await store.ingest({ snapshot: current })).toMatchObject({
      replayed: true,
    });
    snapshot.sequence++;
  }
  expect((await store.api.listPeople({ account_id })).items).toEqual([]);
  expect(
    (await store.api.listResources({ account_id, scope: "for-you" })).items,
  ).toEqual([]);
  expect((await store.api.listResources({ account_id })).items).toHaveLength(1);
});

test("notification fields participate in source replay hashes and validation", async () => {
  const current = { ...snapshot, notification_events: [event] };
  await store.ingest({ snapshot: current });
  await expect(
    store.ingest({
      snapshot: {
        ...current,
        notification_events: [{ ...event, mention_all: true }],
      },
    }),
  ).rejects.toThrow("sequence reused");
  snapshot.sequence++;
  for (const notification_events of [
    [event, event],
    [{ ...event, room_id: foreign }],
    [{ ...event, project_id: foreign }],
    [{ ...event, activity: 2 }],
    Array.from({ length: 101 }, () => event),
  ])
    await expect(
      store.ingest({ snapshot: { ...snapshot, notification_events } }),
    ).rejects.toThrow();
  expect(
    (await store.writerState({ project_id, chat_path: snapshot.chat_path }))
      ?.source_sequence,
  ).toBe(1);
});
