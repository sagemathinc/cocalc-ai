import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import type { ArtifactCatalogSnapshot } from "@cocalc/util/artifact-catalog";
import {
  applyArtifactCatalogSnapshot,
  readProjectArtifactCatalog,
  registerArtifactCatalogSource,
} from "./artifact-catalog";

jest.mock("@cocalc/util/artifact-catalog", () => ({
  ...jest.requireActual("@cocalc/util/artifact-catalog"),
  ARTIFACT_CATALOG_MAX_PROJECT_SOURCES: 2,
  ARTIFACT_CATALOG_MAX_PROJECT_SOURCE_BYTES: 100,
  ARTIFACT_CATALOG_MAX_PROJECT_ITEMS: 3,
  ARTIFACT_CATALOG_MAX_PROJECT_BYTES: 1000,
  ARTIFACT_CATALOG_MAX_PROJECT_WORK_PER_HOUR: 12,
}));

const project_id = "11111111-1111-4111-8111-111111111111";
const host_id = "22222222-2222-4222-8222-222222222222";
const authority = { owning_bay_id: "bay-test", host_id };
const first = { project_id, chat_path: "/a.chat" };
const second = { project_id, chat_path: "/b.chat" };
let firstEpoch: string;
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

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 30000);
beforeEach(async () => {
  await getPool().query(
    "TRUNCATE artifact_catalog,artifact_catalog_sources,artifact_catalog_project_budget,projects CASCADE",
  );
  await getPool().query(
    "INSERT INTO projects(project_id,host_id,owning_bay_id,users) VALUES($1,$2,$3,'{}'::jsonb)",
    [project_id, host_id, authority.owning_bay_id],
  );
  firstEpoch = await registerArtifactCatalogSource(
    first,
    authority,
    null,
    randomUUID(),
  );
});
afterAll(async () => {
  await testCleanup();
});

test("source count and path-byte limits reject new sources without affecting existing ones", async () => {
  await expect(
    registerArtifactCatalogSource(
      { project_id, chat_path: `/${"x".repeat(90)}.chat` },
      authority,
      null,
      randomUUID(),
    ),
  ).rejects.toThrow("source limit");
  await registerArtifactCatalogSource(second, authority, null, randomUUID());
  await expect(
    registerArtifactCatalogSource(
      { project_id, chat_path: "/c.chat" },
      authority,
      null,
      randomUUID(),
    ),
  ).rejects.toThrow("source limit");
  const rows = await getPool().query(
    "SELECT chat_path FROM artifact_catalog_sources WHERE project_id=$1 ORDER BY chat_path",
    [project_id],
  );
  expect(rows.rows.map((row) => row.chat_path)).toEqual(["/a.chat", "/b.chat"]);
});

test("project entry quota rejects a replacement atomically", async () => {
  await applyArtifactCatalogSnapshot(
    snapshot(first, firstEpoch, 1, [item("a"), item("b")]),
    authority,
  );
  const secondEpoch = await registerArtifactCatalogSource(
    second,
    authority,
    null,
    randomUUID(),
  );
  await expect(
    applyArtifactCatalogSnapshot(
      snapshot(second, secondEpoch, 1, [item("c"), item("d")]),
      authority,
    ),
  ).rejects.toThrow("metadata limit");
  expect((await readProjectArtifactCatalog(project_id)).entries).toHaveLength(
    2,
  );
  const state = await getPool().query(
    "SELECT source_sequence FROM artifact_catalog_sources WHERE chat_path=$1",
    [second.chat_path],
  );
  expect(Number(state.rows[0].source_sequence)).toBe(0);
  await applyArtifactCatalogSnapshot(
    snapshot(second, secondEpoch, 1, [item("c")]),
    authority,
  );
  expect((await readProjectArtifactCatalog(project_id)).entries).toHaveLength(
    3,
  );
});

test("metadata-byte quota retains the last valid catalog", async () => {
  await applyArtifactCatalogSnapshot(
    snapshot(first, firstEpoch, 1, [item("a")]),
    authority,
  );
  await expect(
    applyArtifactCatalogSnapshot(
      snapshot(first, firstEpoch, 2, [item("a", "x".repeat(950))]),
      authority,
    ),
  ).rejects.toThrow("metadata limit");
  expect(
    (await readProjectArtifactCatalog(project_id)).entries[0].item.description,
  ).toBe("");
});

test("project work budget rejects repeated changing snapshots before rewriting rows", async () => {
  await applyArtifactCatalogSnapshot(
    snapshot(first, firstEpoch, 1, [item("1")]),
    authority,
  );
  for (let sequence = 2; sequence <= 6; sequence++)
    await applyArtifactCatalogSnapshot(
      snapshot(first, firstEpoch, sequence, [item(`${sequence}`)]),
      authority,
    );
  await expect(
    applyArtifactCatalogSnapshot(
      snapshot(first, firstEpoch, 7, [item("7")]),
      authority,
    ),
  ).rejects.toThrow("mutation budget");
  const state = await getPool().query(
    "SELECT source_sequence FROM artifact_catalog_sources WHERE chat_path=$1",
    [first.chat_path],
  );
  expect(Number(state.rows[0].source_sequence)).toBe(6);
  expect(
    (await readProjectArtifactCatalog(project_id)).entries[0].item.artifact_id,
  ).toBe("6");
  await getPool().query(
    "UPDATE artifact_catalog_project_budget SET window_start=now()-interval '2 hours' WHERE project_id=$1",
    [project_id],
  );
  await expect(
    applyArtifactCatalogSnapshot(
      snapshot(first, firstEpoch, 7, [item("7")]),
      authority,
    ),
  ).resolves.toMatchObject({ revision: 7 });
});

test("concurrent sources cannot both pass a project-wide quota", async () => {
  const secondEpoch = await registerArtifactCatalogSource(
    second,
    authority,
    null,
    randomUUID(),
  );
  const results = await Promise.allSettled([
    applyArtifactCatalogSnapshot(
      snapshot(first, firstEpoch, 1, [item("a"), item("b")]),
      authority,
    ),
    applyArtifactCatalogSnapshot(
      snapshot(second, secondEpoch, 1, [item("c"), item("d")]),
      authority,
    ),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect((await readProjectArtifactCatalog(project_id)).entries).toHaveLength(
    2,
  );
});
