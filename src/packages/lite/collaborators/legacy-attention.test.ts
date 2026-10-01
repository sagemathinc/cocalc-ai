/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LiteCollaborators } from "./index";
import { attachLegacyAttention } from "./legacy-attention";
import type { LocalResource } from "./legacy-attention";
const account_id = "11111111-1111-4111-8111-111111111111";
const project_id = "22222222-2222-4222-8222-222222222222";
const chat_path = "/home/user/legacy.chat";
const resource: LocalResource = {
  project_id,
  chat_path,
  kind: "conversation",
  resource_id: "thread",
  thread_id: "thread",
  title: "Legacy",
  participant_ids: [],
  created_at: 1,
  updated_at: 2,
  activity: 3,
};
let directory: string, filename: string, epoch: string, sequence: number;
let store: LiteCollaborators;
const options = () => ({
  filename,
  project_id,
  account_id,
  isEnabled: () => true,
});
const ingest = (
  legacy?: { following: boolean; muted: boolean },
  changes: Partial<LocalResource> = {},
) =>
  store.ingest({
    snapshot: {
      project_id,
      chat_path,
      epoch,
      sequence: sequence++,
      resources: [
        {
          ...resource,
          ...changes,
          ...(legacy ? { lite_legacy_attention: legacy } : {}),
        },
      ],
    },
  });
const target = { ...resource, account_id };
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "lite-attention-"));
  filename = join(directory, "catalog.sqlite");
  sequence = 1;
  store = new LiteCollaborators(options());
  ({ epoch } = await store.registerSource({
    project_id,
    chat_path,
    expected_epoch: null,
    registration_id: "writer",
  }));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("legacy choices migrate once, survive restart, and never leak internal account summaries", async () => {
  await ingest({ following: true, muted: true });
  expect((await store.api.getResource(target))?.personal).toMatchObject({
    following: true,
    muted: true,
    read_through: 3,
  });
  expect(
    JSON.stringify(await store.api.listResources({ account_id })),
  ).not.toContain("lite_legacy_attention");
  await ingest({ following: true, muted: true }, { activity: 6 });
  await store.api.setPersonalState({
    ...target,
    patch: { following: false, muted: false, collected: true, read_through: 4 },
  });
  store.close();
  store = new LiteCollaborators(options());
  await ingest({ following: true, muted: true });
  expect((await store.api.getResource(target))?.personal).toMatchObject({
    following: false,
    muted: false,
    collected: true,
    read_through: 4,
  });
});

test.each([true, false])(
  "history boundary never advances on repair, restart, or restore; explicit attention %s survives",
  async (following) => {
    await ingest({ following: !following, muted: following });
    expect((await store.api.getResource(target))?.personal?.read_through).toBe(
      3,
    );
    await store.api.setPersonalState({
      ...target,
      patch: { following, muted: !following },
    });
    await ingest({ following: !following, muted: following }, { activity: 9 });
    await store.api.setPersonalState({ ...target, patch: { read_through: 5 } });
    store.close();
    store = new LiteCollaborators(options());
    await ingest(
      { following: !following, muted: following },
      { title: "Metadata repair", activity: 2 },
    );
    expect(await store.api.getResource(target)).toMatchObject({
      activity: 9,
      personal: { read_through: 5, following, muted: !following },
    });
    await store.ingest({
      snapshot: {
        project_id,
        chat_path,
        epoch,
        sequence: sequence++,
        resources: [],
      },
    });
    await ingest({ following: !following, muted: following }, { activity: 12 });
    expect(await store.api.getResource(target)).toMatchObject({
      activity: 12,
      personal: { read_through: 5, following, muted: !following },
    });
  },
);

test("an explicit default false before migration is not overwritten, but alias-only choices do not block migration", async () => {
  await ingest();
  await store.api.setPersonalState({
    ...target,
    patch: { following: false, alias: "notes" },
  });
  store.close();
  store = new LiteCollaborators(options());
  await ingest({ following: true, muted: true });
  expect((await store.api.getResource(target))?.personal).toMatchObject({
    alias: "notes",
    following: false,
    muted: true,
  });
});

test("alias and collection alone do not turn default false into an explicit attention choice", async () => {
  await ingest();
  await store.api.setPersonalState({
    ...target,
    patch: { alias: "notes", collected: true },
  });
  store.close();
  store = new LiteCollaborators(options());
  await ingest({ following: true, muted: true });
  expect((await store.api.getResource(target))?.personal).toMatchObject({
    alias: "notes",
    collected: true,
    following: true,
    muted: true,
  });
});

test("stale writers cannot migrate or overwrite choices", async () => {
  await ingest();
  const current = await store.registerSource({
    project_id,
    chat_path,
    registration_id: "new-writer",
    expected_epoch: epoch,
  });
  await expect(ingest({ following: true, muted: true })).rejects.toThrow(
    "epoch",
  );
  expect((await store.api.getResource(target))?.personal).toMatchObject({
    following: false,
    muted: false,
  });
  epoch = current.epoch;
  sequence = 1;
  await ingest({ following: true, muted: true });
  expect(
    (await store.api.listResources({ account_id, scope: "for-you" })).items[0]
      .reason,
  ).toBe("following");
});

test("source summaries include only the local account, never other members or copied attention", () => {
  const rows = [
    {
      event: "chat-thread-config",
      thread_id: "thread",
      notification_followers: [project_id, account_id],
      notification_muted: [project_id],
    },
  ];
  const extraction = attachLegacyAttention(
    { resources: [resource] },
    rows,
    account_id,
  );
  expect(extraction.resources[0].lite_legacy_attention).toEqual({
    following: true,
    muted: false,
  });
  expect(extraction.resources[0].participant_ids).toEqual([]);
  const copied = attachLegacyAttention(
    { resources: [resource] },
    [
      ...rows,
      { event: "collaborators-identity", identity_namespace: project_id },
    ],
    account_id,
  );
  expect(copied.resources[0].lite_legacy_attention).toEqual({
    following: false,
    muted: false,
  });
});
