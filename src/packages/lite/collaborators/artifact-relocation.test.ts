/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ArtifactCatalogJournal } from "@cocalc/backend/artifacts/journal";
import { artifactCatalogKey } from "@cocalc/util/artifact-catalog";
import type { ArtifactCatalogItem } from "@cocalc/util/artifact-catalog";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { LiteArtifactCatalog } from "../artifacts/catalog";
import { LitePersonalLibrary } from "../artifacts/personal-library";
import { LiteArtifactRelocation } from "./artifact-relocation";
import { LiteCollaborators } from "./index";
import { artifactPin } from "./library";

const project_id = "11111111-1111-4111-8111-111111111111",
  account_id = "22222222-2222-4222-8222-222222222222";
const from_chat_path = "/home/user/artifacts.chat",
  to_chat_path = "/home/user/moved.chat";
const item: ArtifactCatalogItem = {
  thread_id: "thread",
  artifact_id: "artifact",
  kind: "file",
  title: "Proof",
  description: "Published proof",
  created_at: 1,
  publication: { operation_id: "publish", message_id: "message" },
};
const entryId = (chat_path: string) =>
  createHash("sha256")
    .update(artifactCatalogKey({ project_id, chat_path }, item))
    .digest("hex");
const resource: CollaborationResource = {
  project_id,
  chat_path: from_chat_path,
  kind: "artifact",
  resource_id: "stable-artifact",
  thread_id: item.thread_id,
  artifact_id: item.artifact_id,
  entry_id: entryId(from_chat_path),
  title: item.title,
  participant_ids: [],
  created_at: 1,
  updated_at: 2,
  activity: 3,
};
let directory: string,
  storeFilename: string,
  epoch: string,
  artifactEpoch: string;
let store: LiteCollaborators,
  catalog: LiteArtifactCatalog,
  journal: ArtifactCatalogJournal,
  library: LitePersonalLibrary,
  relocator: LiteArtifactRelocation;
let failAfterExternalCommit: boolean;
const storeOptions = () => ({
  filename: storeFilename,
  project_id,
  account_id,
  isEnabled: () => true,
  personalLibrary: () => library,
  artifactRelocator: {
    relocate: (...args: Parameters<LiteArtifactRelocation["relocate"]>) => {
      relocator.relocate(...args);
      if (failAfterExternalCommit) {
        failAfterExternalCommit = false;
        throw Error("simulated owner commit interruption");
      }
    },
  },
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
  directory = mkdtempSync(join(tmpdir(), "lite-artifact-move-"));
  const artifactDirectory = join(directory, "artifact-catalog");
  mkdirSync(artifactDirectory);
  const filename = join(artifactDirectory, "catalog.sqlite");
  catalog = new LiteArtifactCatalog({ filename, project_id });
  journal = new ArtifactCatalogJournal(
    join(artifactDirectory, "journal.sqlite"),
  );
  const personalLibraryFilename = join(directory, "library.sqlite");
  library = new LitePersonalLibrary({
    filename: personalLibraryFilename,
    account_id,
    project_id,
    artifactExists: async (project_id, entry_id) =>
      !!(await catalog.getEntry({ project_id, entry_id })),
  });
  storeFilename = join(directory, "collaborators.sqlite");
  store = new LiteCollaborators(storeOptions());
  relocator = new LiteArtifactRelocation({
    filename,
    catalog,
    journal,
    project_id,
    account_id,
    personalLibraryFilename,
    pending: (path) => store.isRelocating(path),
  });
  relocator.bindLibrary(library);
  failAfterExternalCommit = false;
  ({ epoch: artifactEpoch } = await catalog.registerSource({
    project_id,
    chat_path: from_chat_path,
    registration_id: "artifact-writer",
    expected_epoch: null,
  }));
  await catalog.applySnapshot({
    schema_version: 1,
    project_id,
    chat_path: from_chat_path,
    epoch: artifactEpoch,
    sequence: 1,
    items: [item],
  });
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
      resources: [resource],
    },
  });
  await library.name({
    account_id,
    project_id,
    entry_id: resource.entry_id!,
    name: "historical",
  });
  await store.api.setPersonalState({
    ...resource,
    account_id,
    patch: {
      alias: "proof",
      collected: true,
      following: true,
      read_through: 2,
    },
  });
});
afterEach(() => {
  relocator.close();
  store.close();
  library.close();
  journal.close();
  catalog.close();
  rmSync(directory, { recursive: true, force: true });
});

test("artifact moves preserve old bound references, current/historical names, pins, attention and identity", async () => {
  const result = await store.relocateSource(request());
  expect(await store.relocateSource(request())).toEqual(result);
  const moved = await store.api.getResource({ ...resource, account_id });
  expect(moved).toMatchObject({
    resource_id: resource.resource_id,
    chat_path: to_chat_path,
    entry_id: entryId(to_chat_path),
    personal: {
      alias: "proof",
      collected: true,
      following: true,
      read_through: 2,
    },
  });
  expect(
    await catalog.getEntry({ project_id, entry_id: resource.entry_id! }),
  ).toMatchObject({
    chat_path: to_chat_path,
    entry_id: entryId(to_chat_path),
    item,
  });
  expect((await catalog.listProject({ project_id })).entries).toHaveLength(1);
  expect((await library.list({ account_id })).pins).toEqual([
    artifactPin(moved!),
  ]);
  expect(
    await library.resolve({ account_id, name: "historical" }),
  ).toMatchObject({ active: false, entry_id: entryId(to_chat_path) });
  expect(await library.resolve({ account_id, name: "proof" })).toMatchObject({
    active: true,
    entry_id: entryId(to_chat_path),
  });
  await expect(
    catalog.applySnapshot({
      schema_version: 1,
      project_id,
      chat_path: from_chat_path,
      epoch: artifactEpoch,
      sequence: 2,
      items: [item],
    }),
  ).rejects.toThrow("relocated");
  expect((await catalog.sourcePage({ project_id })).paths).toEqual([
    to_chat_path,
  ]);
  expect(
    journal
      .pendingRegistrations(100)
      .some((registration) => registration.chat_path === to_chat_path),
  ).toBe(true);
});

test("cross-database interruption resumes from durable receipts after owner restart", async () => {
  failAfterExternalCommit = true;
  await expect(store.relocateSource(request())).rejects.toThrow("interruption");
  await expect(store.api.listResources({ account_id })).rejects.toThrow(
    "recovery",
  );
  await expect(
    store.registerSource({
      project_id,
      chat_path: from_chat_path,
      expected_epoch: epoch,
      registration_id: "racing-writer",
    }),
  ).rejects.toThrow("pending");
  store.close();
  store = new LiteCollaborators(storeOptions());
  await store.resumeRelocations();
  expect(
    await store.api.getResource({ ...resource, account_id }),
  ).toMatchObject({
    chat_path: to_chat_path,
    entry_id: entryId(to_chat_path),
    personal: {
      alias: "proof",
      collected: true,
      following: true,
      read_through: 2,
    },
  });
  expect((await library.list({ account_id })).pins).toHaveLength(1);
});

test("moving back compresses redirects and preserves both generations of bound references", async () => {
  const first = await store.relocateSource(request());
  const old = await store.writerState({
    project_id,
    chat_path: from_chat_path,
  });
  await store.relocateSource({
    project_id,
    operation_id: "move-back",
    from_chat_path: to_chat_path,
    to_chat_path: from_chat_path,
    expected_epoch: first.epoch,
    expected_destination_epoch: old!.epoch,
  });
  for (const path of [from_chat_path, to_chat_path])
    expect(
      await catalog.getEntry({ project_id, entry_id: entryId(path) }),
    ).toMatchObject({
      chat_path: from_chat_path,
      entry_id: entryId(from_chat_path),
    });
  expect((await library.list({ account_id })).pins).toEqual([
    artifactPin(resource),
  ]);
  expect(
    (await store.api.getResource({ ...resource, account_id }))?.personal?.alias,
  ).toBe("proof");
});

test("occupied artifact destination leaves all authorities unchanged and does not wedge recovery", async () => {
  const destination = await catalog.registerSource({
    project_id,
    chat_path: to_chat_path,
    registration_id: "occupied",
    expected_epoch: null,
  });
  await catalog.applySnapshot({
    schema_version: 1,
    project_id,
    chat_path: to_chat_path,
    epoch: destination.epoch,
    sequence: 1,
    items: [item],
  });
  await expect(store.relocateSource(request())).rejects.toThrow("occupied");
  expect(
    (await store.api.getResource({ ...resource, account_id }))?.chat_path,
  ).toBe(from_chat_path);
  expect((await library.list({ account_id })).pins).toEqual([
    artifactPin(resource),
  ]);
});

test("legacy open tabs can rename or unpin using their pre-move Library targets", async () => {
  await store.relocateSource(request());
  await library.name({
    account_id,
    project_id,
    entry_id: resource.entry_id!,
    name: "renamed",
  });
  expect(
    (await store.api.getResource({ ...resource, account_id }))?.personal?.alias,
  ).toBe("renamed");
  expect(await library.resolve({ account_id, name: "renamed" })).toMatchObject({
    entry_id: entryId(to_chat_path),
    active: true,
  });
  await library.setPinned({
    account_id,
    pin_key: artifactPin(resource),
    pinned: false,
  });
  expect((await library.list({ account_id })).pins).toEqual([]);
  await library.setPinned({
    account_id,
    pin_key: artifactPin(resource),
    pinned: true,
  });
  expect((await library.list({ account_id })).pins).toEqual([
    artifactPin({ ...resource, chat_path: to_chat_path }),
  ]);
});
