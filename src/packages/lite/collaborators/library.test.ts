/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { LitePersonalLibrary } from "../artifacts/personal-library";
import { LiteCollaborators } from "./index";
import { artifactPin } from "./library";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liteArtifactAliasRemover } from "./library-store";

const project_id = "11111111-1111-4111-8111-111111111111";
const account_id = "human";
const chat_path = "/home/user/artifacts.chat";
const artifact: CollaborationResource = {
  project_id,
  chat_path,
  kind: "artifact",
  resource_id: "artifact-stable",
  thread_id: "thread",
  artifact_id: "native",
  entry_id: "a".repeat(64),
  title: "Shared proof",
  participant_ids: [],
  created_at: 1,
  updated_at: 2,
  activity: 3,
};
let library: LitePersonalLibrary;
let store: LiteCollaborators;
let directory: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-library-"));
  const filename = join(directory, "library.sqlite");
  library = new LitePersonalLibrary({
    filename,
    account_id,
    project_id,
    artifactExists: async () => true,
  });
  store = new LiteCollaborators({
    filename: ":memory:",
    account_id,
    project_id,
    isEnabled: () => true,
    personalLibrary: () => library,
    clearArtifactAlias: liteArtifactAliasRemover(filename),
  });
  const { epoch } = await store.registerSource({
    project_id,
    chat_path,
    expected_epoch: null,
    registration_id: "writer",
  });
  await store.ingest({
    snapshot: {
      project_id,
      chat_path,
      epoch,
      sequence: 1,
      resources: [artifact],
    },
  });
});

afterEach(() => {
  store.close();
  library.close();
  rmSync(directory, { recursive: true, force: true });
});

test("existing Library aliases/pins are the live query authority, not a competing registry", async () => {
  await library.name({
    account_id,
    project_id,
    entry_id: artifact.entry_id!,
    name: "proof",
  });
  await library.setPinned({
    account_id,
    pin_key: artifactPin(artifact),
    pinned: true,
  });
  const page = await store.api.listResources({
    account_id,
    search: "pro",
    scope: "collected",
  });
  expect(page.items).toHaveLength(1);
  expect(page.items[0].personal).toEqual({
    alias: "proof",
    collected: true,
    following: false,
    muted: false,
    read_through: 0,
  });
  await library.name({
    account_id,
    project_id,
    entry_id: artifact.entry_id!,
    name: "lemma",
  });
  expect(
    (await store.api.listResources({ account_id, search: "lemma" })).items,
  ).toHaveLength(1);
  await library.setPinned({
    account_id,
    pin_key: artifactPin(artifact),
    pinned: false,
  });
  expect(
    (await store.api.listResources({ account_id, scope: "collected" })).items,
  ).toEqual([]);
});

test("Collaborators writes use Library APIs while preserving independent attention", async () => {
  await store.api.setPersonalState({
    ...artifact,
    account_id,
    patch: {
      alias: "notes",
      collected: true,
      following: true,
      read_through: 2,
    },
  });
  const snapshot = await library.list({ account_id });
  expect(snapshot.aliases).toMatchObject([
    { name: "notes", entry_id: artifact.entry_id, active: true },
  ]);
  expect(snapshot.pins).toEqual([artifactPin(artifact)]);
  await library.name({
    account_id,
    project_id,
    entry_id: artifact.entry_id!,
    name: "renamed",
  });
  expect(
    (await store.api.getResource({ ...artifact, account_id }))?.personal,
  ).toEqual({
    alias: "renamed",
    collected: true,
    following: true,
    muted: false,
    read_through: 2,
  });
  await store.api.setPersonalState({
    ...artifact,
    account_id,
    patch: { collected: false },
  });
  expect((await library.list({ account_id })).pins).toEqual([]);
  expect(
    (await store.api.getResource({ ...artifact, account_id }))?.personal
      ?.following,
  ).toBe(true);
});

test("alias removal preserves historical binding, collection and attention independently", async () => {
  await store.api.setPersonalState({
    ...artifact,
    account_id,
    patch: { alias: "notes", collected: true, following: true },
  });
  await store.api.setPersonalState({
    ...artifact,
    account_id,
    patch: { alias: "" },
  });
  expect((await library.list({ account_id })).pins).toEqual([
    artifactPin(artifact),
  ]);
  expect(
    (await store.api.getResource({ ...artifact, account_id }))?.personal,
  ).toMatchObject({ collected: true, following: true });
  expect(
    (await store.api.getResource({ ...artifact, account_id }))?.personal?.alias,
  ).toBeUndefined();
  await store.api.setPersonalState({
    ...artifact,
    account_id,
    patch: { collected: false },
  });
  expect((await library.resolve({ account_id, name: "notes" }))?.active).toBe(
    false,
  );
  expect((await library.resolve({ account_id, name: "notes" }))?.entry_id).toBe(
    artifact.entry_id,
  );
});

test("polling refreshes changes made through the original Library UI", async () => {
  const first = await store.api.listResources({ account_id });
  await library.name({
    account_id,
    project_id,
    entry_id: artifact.entry_id!,
    name: "renamed",
  });
  const update = await store.api.check({ account_id, since: first.revision });
  expect(update.reset).toBe(true);
  expect(
    await store.api.check({ account_id, since: update.revision }),
  ).toMatchObject({ reset: false });
});

test("the store-only alias remover rejects another owner or project", async () => {
  const clear = liteArtifactAliasRemover(join(directory, "library.sqlite"));
  await expect(
    clear({ account_id: "stranger", project_id, entry_id: artifact.entry_id! }),
  ).rejects.toThrow("unavailable");
  await expect(
    clear({
      account_id,
      project_id: "33333333-3333-4333-8333-333333333333",
      entry_id: artifact.entry_id!,
    }),
  ).rejects.toThrow("unavailable");
});

test("personal Library state cannot manufacture discoverability for unavailable artifacts", async () => {
  await library.name({
    account_id,
    project_id,
    entry_id: "b".repeat(64),
    name: "unavailable",
  });
  expect(
    (await store.api.listResources({ account_id, search: "unavailable" }))
      .items,
  ).toEqual([]);
  expect((await store.api.listResources({ account_id })).items).toHaveLength(1);
});
