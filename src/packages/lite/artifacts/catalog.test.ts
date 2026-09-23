/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { artifactCatalogKey } from "@cocalc/util/artifact-catalog";
import type {
  ArtifactCatalogItem,
  ArtifactCatalogSnapshot,
} from "@cocalc/util/artifact-catalog";
import { LiteArtifactCatalog, liteArtifactCatalogReadApi } from "./catalog";

const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/test.chat",
};
const otherProject = "22222222-2222-4222-8222-222222222222";
const item = (artifact_id = "artifact"): ArtifactCatalogItem => ({
  thread_id: "thread",
  artifact_id,
  title: "Title",
  description: "Description",
  kind: "file",
  created_at: 1000,
  publication: { operation_id: "op", message_id: "msg" },
  target: { path: "result.txt" },
});
let directory: string;
let filename: string;
let catalog: LiteArtifactCatalog;
let epoch: string;
const snapshot = (sequence = 1, items = [item()]): ArtifactCatalogSnapshot => ({
  ...source,
  schema_version: 1,
  epoch,
  sequence,
  items,
});
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "lite-artifacts-"));
  filename = join(directory, "catalog.sqlite");
  catalog = new LiteArtifactCatalog({
    filename,
    project_id: source.project_id,
  });
  ({ epoch } = await catalog.registerSource({
    ...source,
    expected_epoch: null,
    registration_id: "registration",
  }));
});
afterEach(() => {
  catalog.close();
  rmSync(directory, { recursive: true, force: true });
});

test("registration retry, CAS fencing, writer state and restart", async () => {
  expect(await catalog.writerState(source)).toEqual({
    epoch,
    registration_id: "registration",
    source_sequence: 0,
    writer_host_id: null,
  });
  expect(
    await catalog.registerSource({
      ...source,
      expected_epoch: null,
      registration_id: "registration",
    }),
  ).toEqual({ epoch });
  await catalog.applySnapshot(snapshot());
  catalog.close();
  catalog = new LiteArtifactCatalog({
    filename,
    project_id: source.project_id,
  });
  expect((await catalog.writerState(source))?.source_sequence).toBe(1);
  const rotated = await catalog.registerSource({
    ...source,
    expected_epoch: epoch,
    registration_id: "next",
  });
  await expect(
    catalog.registerSource({
      ...source,
      expected_epoch: epoch,
      registration_id: "delayed",
    }),
  ).rejects.toThrow("epoch changed");
  await expect(
    catalog.registerSource({
      ...source,
      expected_epoch: null,
      registration_id: "registration",
    }),
  ).rejects.toThrow("epoch changed");
  await expect(catalog.applySnapshot(snapshot(2))).rejects.toThrow(
    "stale artifact catalog writer epoch",
  );
  expect((await catalog.listProject(source)).entries).toHaveLength(1);
  expect((await catalog.listProject(source)).indexed_sources).toBe(0);
  expect(
    await catalog.applySnapshot({ ...snapshot(), epoch: rotated.epoch }),
  ).toEqual({ revision: 1, replayed: true });
});

test("independent connections serialize registration CAS", async () => {
  const second = new LiteArtifactCatalog({
    filename,
    project_id: source.project_id,
  });
  try {
    const results = await Promise.allSettled([
      catalog.registerSource({
        ...source,
        expected_epoch: epoch,
        registration_id: "a",
      }),
      second.registerSource({
        ...source,
        expected_epoch: epoch,
        registration_id: "b",
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(await second.writerState(source)).toEqual(
      await catalog.writerState(source),
    );
  } finally {
    second.close();
  }
});

test("snapshot canonical replay, content hash, sequence gaps and stale deliveries", async () => {
  expect(
    await catalog.applySnapshot(snapshot(1, [item("b"), item("a")])),
  ).toEqual({ revision: 1, replayed: false });
  expect(
    await catalog.applySnapshot(snapshot(1, [item("a"), item("b")])),
  ).toEqual({ revision: 1, replayed: true });
  expect(
    await catalog.applySnapshot(snapshot(5, [item("b"), item("a")])),
  ).toEqual({ revision: 1, replayed: true });
  await expect(catalog.applySnapshot(snapshot(4))).rejects.toThrow(
    "stale artifact catalog snapshot",
  );
  await expect(catalog.applySnapshot(snapshot(5))).rejects.toThrow(
    "sequence reused",
  );
  expect(await catalog.applySnapshot(snapshot(6))).toEqual({
    revision: 2,
    replayed: false,
  });
  expect((await catalog.writerState(source))?.source_sequence).toBe(6);
});

test("edits, removal and reappearance preserve first creation time and stable entry identity", async () => {
  await catalog.applySnapshot(snapshot());
  const original = (await catalog.listProject(source)).entries[0];
  const request = {
    project_id: source.project_id,
    entry_id: original.entry_id,
  };
  await expect(catalog.getEntry(request)).resolves.toEqual(original);
  expect(original.entry_id).toBe(
    createHash("sha256")
      .update(artifactCatalogKey(source, item()))
      .digest("hex"),
  );
  await catalog.applySnapshot(
    snapshot(2, [{ ...item(), title: "Edited", created_at: 5000 }]),
  );
  expect((await catalog.listProject(source)).entries[0].item).toMatchObject({
    created_at: 1000,
    title: "Edited",
  });
  await catalog.applySnapshot(snapshot(3, []));
  await expect(catalog.getEntry(request)).resolves.toBeNull();
  expect(await catalog.listProject(source)).toEqual({
    entries: [],
    indexed_sources: 1,
  });
  expect(await catalog.sourcePage(source)).toEqual({
    paths: [source.chat_path],
  });
  await catalog.applySnapshot(snapshot(4, [{ ...item(), created_at: 9000 }]));
  expect((await catalog.listProject(source)).entries[0]).toEqual(original);
  await expect(catalog.getEntry(request)).resolves.toEqual(original);
});

test("bounded project keyset pages include separate chat and thread identities", async () => {
  await catalog.applySnapshot(
    snapshot(
      1,
      Array.from({ length: 100 }, (_, i) => item(String(i))),
    ),
  );
  const nextSource = { ...source, chat_path: "/home/user/second.chat" };
  const next = await catalog.registerSource({
    ...nextSource,
    expected_epoch: null,
    registration_id: "next-source",
  });
  await catalog.applySnapshot({
    ...snapshot(1, [item("0"), { ...item("0"), thread_id: "other" }]),
    ...nextSource,
    epoch: next.epoch,
  });
  const first = await catalog.listProject(source);
  expect(first.entries).toHaveLength(100);
  expect(first.indexed_sources).toBe(2);
  expect(first.next).toBe(first.entries[99].entry_id);
  const second = await catalog.listProject({ ...source, after: first.next });
  expect(second.entries).toHaveLength(2);
  await expect(
    catalog.getEntry({
      project_id: source.project_id,
      entry_id: second.entries[1].entry_id,
    }),
  ).resolves.toEqual(second.entries[1]);
  expect(second.next).toBeUndefined();
  const ids = [...first.entries, ...second.entries].map(
    (entry) => entry.entry_id,
  );
  expect(ids).toEqual([...ids].sort());
  expect(new Set(ids).size).toBe(102);
  expect(
    (
      await catalog.listProject({
        ...source,
        after: second.entries[1].entry_id,
      })
    ).entries,
  ).toEqual([]);
});

test("source keyset pages include unindexed sources and remain bounded", async () => {
  for (let i = 0; i < 100; i++)
    await catalog.registerSource({
      ...source,
      chat_path: `/home/user/${String(i).padStart(3, "0")}.chat`,
      expected_epoch: null,
      registration_id: `source-${i}`,
    });
  const first = await catalog.sourcePage(source);
  expect(first.paths).toHaveLength(100);
  expect(first.next).toBe(first.paths[99]);
  expect(await catalog.sourcePage({ ...source, after: first.next })).toEqual({
    paths: [source.chat_path],
  });
  expect((await catalog.listProject(source)).indexed_sources).toBe(0);
});

test("metadata validation strips content and rejects invalid, duplicate and oversized payloads without consuming sequence", async () => {
  await expect(
    catalog.applySnapshot(snapshot(1, [item(), item()])),
  ).rejects.toThrow("duplicate");
  await expect(
    catalog.applySnapshot(snapshot(1, [{ ...item(), title: "x".repeat(513) }])),
  ).rejects.toThrow();
  await expect(
    catalog.applySnapshot(
      snapshot(
        1,
        Array.from({ length: 5001 }, (_, i) => item(String(i))),
      ),
    ),
  ).rejects.toThrow();
  await expect(
    catalog.applySnapshot(
      snapshot(
        1,
        Array.from({ length: 1500 }, (_, i) => ({
          ...item(String(i)),
          description: "x".repeat(2048),
        })),
      ),
    ),
  ).rejects.toThrow("too large");
  expect((await catalog.writerState(source))?.source_sequence).toBe(0);
  const extra = {
    ...item(),
    content: "secret file content",
    url: "private download",
  };
  await catalog.applySnapshot(snapshot(1, [extra]));
  expect((await catalog.listProject(source)).entries[0].item).toEqual(item());
});

test("failed SQLite replacement rolls back tombstones, entries and sequence", async () => {
  await catalog.applySnapshot(snapshot());
  const db = new DatabaseSync(filename);
  try {
    db.exec(
      "CREATE TRIGGER fail_insert BEFORE INSERT ON lite_artifact_entries BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    await expect(
      catalog.applySnapshot(snapshot(2, [item("new")])),
    ).rejects.toThrow("injected failure");
    expect((await catalog.listProject(source)).entries[0].item).toEqual(item());
    expect((await catalog.writerState(source))?.source_sequence).toBe(1);
    db.exec("DROP TRIGGER fail_insert");
    expect(await catalog.applySnapshot(snapshot(2, [item("new")]))).toEqual({
      revision: 2,
      replayed: false,
    });
  } finally {
    db.close();
  }
});

test("single-project isolation, canonical source validation, API envelope and private permissions", async () => {
  expect(
    () => new LiteArtifactCatalog({ filename, project_id: otherProject }),
  ).toThrow("another Lite project");
  for (const operation of [
    catalog.writerState({ ...source, project_id: otherProject }),
    catalog.listProject({ project_id: otherProject }),
    catalog.sourcePage({ project_id: otherProject }),
    catalog.applySnapshot({ ...snapshot(), project_id: otherProject }),
  ])
    await expect(operation).rejects.toThrow("not available");
  await expect(
    catalog.registerSource({
      ...source,
      chat_path: "/home/user/../bad.chat",
      expected_epoch: null,
      registration_id: "bad",
    }),
  ).rejects.toThrow("canonical");
  await expect(
    catalog.registerSource({
      ...source,
      expected_epoch: null,
      registration_id: "",
    }),
  ).rejects.toThrow("identity");
  await expect(
    catalog.ingest({
      ...source,
      snapshot: { ...snapshot(), chat_path: "/different.chat" },
    }),
  ).rejects.toThrow("source mismatch");
  await expect(
    catalog.listProject({ ...source, after: "bad" }),
  ).rejects.toThrow("cursor");
  await expect(
    catalog.sourcePage({ ...source, after: "x".repeat(4097) }),
  ).rejects.toThrow("cursor");
  expect(statSync(filename).mode & 0o777).toBe(0o600);
  if (process.platform !== "win32")
    for (const suffix of ["-wal", "-shm"])
      expect(statSync(filename + suffix).mode & 0o077).toBe(0);
  const api = liteArtifactCatalogReadApi(catalog, "local-account");
  expect(Object.keys(api).sort()).toEqual(["getEntry", "listProject"]);
  await expect(api.listProject(source)).rejects.toThrow("local Lite account");
  await expect(
    api.listProject({ ...source, account_id: "other" }),
  ).rejects.toThrow("local Lite account");
  expect(
    await api.listProject({ ...source, account_id: "local-account" }),
  ).toEqual({ entries: [], indexed_sources: 0 });
});

test("direct Lite reads validate IDs and use the same account and project boundary as listing", async () => {
  await catalog.applySnapshot(snapshot());
  const entry = (await catalog.listProject(source)).entries[0];
  const request = { project_id: source.project_id, entry_id: entry.entry_id };
  const api = liteArtifactCatalogReadApi(catalog, "local-account");
  const read = jest.spyOn(catalog, "getEntry");
  for (const account_id of [undefined, "other"])
    await expect(api.getEntry({ ...request, account_id })).rejects.toThrow(
      "local Lite account",
    );
  expect(read).not.toHaveBeenCalled();
  const list = jest.spyOn(catalog, "listProject");
  await expect(
    api.getEntry({ ...request, account_id: "local-account" }),
  ).resolves.toEqual(entry);
  expect(list).not.toHaveBeenCalled();
  await expect(
    api.getEntry({
      ...request,
      account_id: "local-account",
      project_id: otherProject,
    }),
  ).rejects.toThrow("not available");
  await expect(
    catalog.getEntry({ ...request, entry_id: "0".repeat(64) }),
  ).resolves.toBeNull();
  for (const entry_id of [undefined, "", "bad", "A".repeat(64), "a".repeat(65)])
    await expect(
      catalog.getEntry({ ...request, entry_id: entry_id! }),
    ).rejects.toThrow("entry_id");
  await expect(
    catalog.getEntry({ ...request, project_id: undefined! }),
  ).rejects.toThrow("not available");
});
