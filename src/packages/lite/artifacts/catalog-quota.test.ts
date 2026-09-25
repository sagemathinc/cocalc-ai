import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ArtifactCatalogSnapshot } from "@cocalc/util/artifact-catalog";
import { LiteArtifactCatalog } from "./catalog";

jest.mock("@cocalc/util/artifact-catalog", () => ({
  ...jest.requireActual("@cocalc/util/artifact-catalog"),
  ARTIFACT_CATALOG_MAX_PROJECT_SOURCES: 2,
  ARTIFACT_CATALOG_MAX_PROJECT_SOURCE_BYTES: 100,
  ARTIFACT_CATALOG_MAX_PROJECT_ITEMS: 3,
  ARTIFACT_CATALOG_MAX_PROJECT_BYTES: 1000,
  ARTIFACT_CATALOG_MAX_PROJECT_WORK_PER_HOUR: 12,
}));

const project_id = "11111111-1111-4111-8111-111111111111";
const first = { project_id, chat_path: "/a.chat" };
const second = { project_id, chat_path: "/b.chat" };
const item = (artifact_id: string, description = "") => ({
  thread_id: "thread",
  artifact_id,
  kind: "file",
  title: "Notes",
  description,
  created_at: 1000,
  publication: { operation_id: "publish", message_id: "message" },
});
const snapshot = (
  source: typeof first,
  epoch: string,
  sequence: number,
  items: ReturnType<typeof item>[],
): ArtifactCatalogSnapshot => ({
  ...source,
  schema_version: 1,
  epoch,
  sequence,
  items,
});

let directory: string;
let filename: string;
let catalog: LiteArtifactCatalog;
let firstEpoch: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "lite-catalog-quota-"));
  filename = join(directory, "catalog.sqlite");
  catalog = new LiteArtifactCatalog({ filename, project_id });
  firstEpoch = (
    await catalog.registerSource({
      ...first,
      expected_epoch: null,
      registration_id: "first",
    })
  ).epoch;
});
afterEach(() => {
  catalog.close();
  rmSync(directory, { recursive: true, force: true });
});

test("rotating identities leaves only current SQLite rows", async () => {
  for (let sequence = 1; sequence <= 3; sequence++) {
    await catalog.applySnapshot(
      snapshot(first, firstEpoch, sequence, [item(`${sequence}`)]),
    );
    const db = new DatabaseSync(filename);
    try {
      expect(
        Number(
          db.prepare("SELECT count(*) AS n FROM lite_artifact_entries").get()
            ?.n,
        ),
      ).toBe(1);
    } finally {
      db.close();
    }
  }
});

test("Lite source and project size limits preserve the prior snapshot", async () => {
  await expect(
    catalog.registerSource({
      project_id,
      chat_path: `/${"x".repeat(90)}.chat`,
      expected_epoch: null,
      registration_id: "long",
    }),
  ).rejects.toThrow("source limit");
  const secondEpoch = (
    await catalog.registerSource({
      ...second,
      expected_epoch: null,
      registration_id: "second",
    })
  ).epoch;
  await expect(
    catalog.registerSource({
      project_id,
      chat_path: "/c.chat",
      expected_epoch: null,
      registration_id: "third",
    }),
  ).rejects.toThrow("source limit");
  await catalog.applySnapshot(
    snapshot(first, firstEpoch, 1, [item("a"), item("b")]),
  );
  await expect(
    catalog.applySnapshot(
      snapshot(second, secondEpoch, 1, [item("c"), item("d")]),
    ),
  ).rejects.toThrow("metadata limit");
  expect((await catalog.listProject({ project_id })).entries).toHaveLength(2);
  expect((await catalog.writerState(second))?.source_sequence).toBe(0);
});

test("Lite byte and work budgets reject changes without advancing the source", async () => {
  await catalog.applySnapshot(snapshot(first, firstEpoch, 1, [item("a")]));
  await expect(
    catalog.applySnapshot(
      snapshot(first, firstEpoch, 2, [item("a", "x".repeat(950))]),
    ),
  ).rejects.toThrow("metadata limit");
  expect((await catalog.writerState(first))?.source_sequence).toBe(1);
  for (let sequence = 2; sequence <= 6; sequence++)
    await catalog.applySnapshot(
      snapshot(first, firstEpoch, sequence, [item(`${sequence}`)]),
    );
  await expect(
    catalog.applySnapshot(snapshot(first, firstEpoch, 7, [item("7")])),
  ).rejects.toThrow("mutation budget");
  expect((await catalog.writerState(first))?.source_sequence).toBe(6);
  const db = new DatabaseSync(filename);
  try {
    db.prepare("UPDATE lite_artifact_budget SET window_start=0").run();
  } finally {
    db.close();
  }
  await expect(
    catalog.applySnapshot(snapshot(first, firstEpoch, 7, [item("7")])),
  ).resolves.toMatchObject({ revision: 7 });
});
