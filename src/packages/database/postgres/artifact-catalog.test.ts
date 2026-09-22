import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import type { ArtifactCatalogSnapshot } from "@cocalc/util/artifact-catalog";
import {
  applyArtifactCatalogSnapshot,
  registerArtifactCatalogSource,
  getArtifactCatalogWriterState,
} from "./artifact-catalog";

const project_id = "11111111-1111-4111-8111-111111111111";
const host_id = "22222222-2222-4222-8222-222222222222";
const authority = { owning_bay_id: "bay-test", host_id };
const source = { project_id, chat_path: "/home/user/work.chat" };
let epoch: string;
const snapshot = (sequence = 1): ArtifactCatalogSnapshot => ({
  ...source,
  schema_version: 1,
  epoch,
  sequence,
  items: [
    {
      thread_id: "thread",
      artifact_id: "artifact",
      kind: "file",
      title: "Notes",
      description: "",
      created_at: 1000,
      publication: { operation_id: "publish", message_id: "message" },
      target: { path: "/home/user/notes.md" },
    },
  ],
});

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 30000);
beforeEach(async () => {
  await getPool().query(
    "TRUNCATE artifact_catalog_outbox,artifact_catalog,artifact_catalog_sources,projects CASCADE",
  );
  await getPool().query(
    `INSERT INTO projects(project_id,host_id,owning_bay_id,users)
    VALUES($1,$2,$3,'{}'::jsonb)`,
    [project_id, host_id, authority.owning_bay_id],
  );
  epoch = await registerArtifactCatalogSource(
    source,
    authority,
    null,
    randomUUID(),
  );
});
afterAll(async () => {
  await testCleanup();
});

test("writer recovery lookup is owner/host checked and reports committed sequence", async () => {
  expect(await getArtifactCatalogWriterState(source, authority)).toMatchObject({
    epoch,
    source_sequence: 0,
    writer_host_id: host_id,
  });
  await applyArtifactCatalogSnapshot(snapshot(3), authority);
  expect(await getArtifactCatalogWriterState(source, authority)).toMatchObject({
    epoch,
    source_sequence: 3,
  });
  expect(
    await getArtifactCatalogWriterState(
      { ...source, chat_path: "/missing.chat" },
      authority,
    ),
  ).toBeNull();
  await expect(
    getArtifactCatalogWriterState(source, {
      ...authority,
      host_id: randomUUID(),
    }),
  ).rejects.toThrow("owner/host");
  await expect(
    getArtifactCatalogWriterState(source, {
      ...authority,
      owning_bay_id: "wrong",
    }),
  ).rejects.toThrow("owner/host");
});

test("catalog writes and projection outbox are atomic and retries do not duplicate events", async () => {
  expect(await applyArtifactCatalogSnapshot(snapshot(), authority)).toEqual({
    revision: 1,
    replayed: false,
  });
  expect(await applyArtifactCatalogSnapshot(snapshot(), authority)).toEqual({
    revision: 1,
    replayed: true,
  });
  const events = (
    await getPool().query("SELECT * FROM artifact_catalog_outbox")
  ).rows;
  expect(events).toHaveLength(1);
  expect(events[0].payload.entries[0].metadata.title).toBe("Notes");
  expect(events[0].published_at).toBeNull();
});

test("rejects different content at the same sequence and older deliveries", async () => {
  await applyArtifactCatalogSnapshot(snapshot(2), authority);
  const changed = snapshot(2);
  changed.items[0].title = "Changed";
  await expect(
    applyArtifactCatalogSnapshot(changed, authority),
  ).rejects.toThrow("sequence reused");
  await expect(
    applyArtifactCatalogSnapshot(snapshot(1), authority),
  ).rejects.toThrow("stale");
});

test("deletion/reappearance and edits preserve original creation order", async () => {
  await applyArtifactCatalogSnapshot(snapshot(), authority);
  await applyArtifactCatalogSnapshot({ ...snapshot(2), items: [] }, authority);
  expect(
    (await getPool().query("SELECT deleted FROM artifact_catalog")).rows[0]
      .deleted,
  ).toBe(true);
  const changed = snapshot(3);
  changed.items[0].created_at = 9999;
  changed.items[0].title = "Renamed";
  await applyArtifactCatalogSnapshot(changed, authority);
  const row = (await getPool().query("SELECT * FROM artifact_catalog")).rows[0];
  expect(row.deleted).toBe(false);
  expect(row.created_at.getTime()).toBe(1000);
  expect(row.metadata.title).toBe("Renamed");
  expect(row.metadata.created_at).toBe(1000);
  const events = (
    await getPool().query(
      "SELECT payload FROM artifact_catalog_outbox ORDER BY revision",
    )
  ).rows;
  expect(events[1].payload.entries).toEqual([]);
  expect(Date.parse(events[2].payload.entries[0].created_at)).toBe(1000);
});

test("wrong bay, reassigned host and deleted project cannot ingest", async () => {
  await expect(
    applyArtifactCatalogSnapshot(snapshot(), {
      ...authority,
      owning_bay_id: "other-bay",
    }),
  ).rejects.toThrow("owner/host");
  await expect(
    applyArtifactCatalogSnapshot(snapshot(), {
      ...authority,
      host_id: randomUUID(),
    }),
  ).rejects.toThrow("owner/host");
  await getPool().query(
    "UPDATE projects SET deleted=TRUE WHERE project_id=$1",
    [project_id],
  );
  await expect(
    applyArtifactCatalogSnapshot(snapshot(), authority),
  ).rejects.toThrow("owner/host");
});

test("epoch registration supports lost-response retry but fences stale registrations and snapshots", async () => {
  await applyArtifactCatalogSnapshot(snapshot(), authority);
  const registration = randomUUID();
  const nextEpoch = await registerArtifactCatalogSource(
    source,
    authority,
    epoch,
    registration,
  );
  expect(
    await registerArtifactCatalogSource(source, authority, epoch, registration),
  ).toBe(nextEpoch);
  await expect(
    registerArtifactCatalogSource(source, authority, epoch, randomUUID()),
  ).rejects.toThrow("epoch changed");
  await expect(
    applyArtifactCatalogSnapshot(snapshot(2), authority),
  ).rejects.toThrow("writer epoch");
  expect(
    await applyArtifactCatalogSnapshot(
      { ...snapshot(), epoch: nextEpoch },
      authority,
    ),
  ).toEqual({ revision: 1, replayed: true });
});

test("outbox failure rolls back metadata and sequence advancement", async () => {
  const pool = getPool();
  await pool.query(
    `ALTER TABLE artifact_catalog_outbox ADD CONSTRAINT catalog_test_fail CHECK (revision < 0)`,
  );
  try {
    await expect(
      applyArtifactCatalogSnapshot(snapshot(), authority),
    ).rejects.toThrow();
    expect((await pool.query("SELECT * FROM artifact_catalog")).rows).toEqual(
      [],
    );
    expect(
      Number(
        (
          await pool.query(
            "SELECT source_sequence FROM artifact_catalog_sources",
          )
        ).rows[0].source_sequence,
      ),
    ).toBe(0);
  } finally {
    await pool.query(
      "ALTER TABLE artifact_catalog_outbox DROP CONSTRAINT catalog_test_fail",
    );
  }
  expect(await applyArtifactCatalogSnapshot(snapshot(), authority)).toEqual({
    revision: 1,
    replayed: false,
  });
});

test("concurrent duplicate delivery produces only one revision", async () => {
  const results = await Promise.all([
    applyArtifactCatalogSnapshot(snapshot(), authority),
    applyArtifactCatalogSnapshot(snapshot(), authority),
  ]);
  expect(results.filter((x) => !x.replayed)).toHaveLength(1);
  expect(
    (await getPool().query("SELECT * FROM artifact_catalog_outbox")).rows,
  ).toHaveLength(1);
});

test("ordinary chat writes do not produce artifact feed churn", async () => {
  await applyArtifactCatalogSnapshot(snapshot(), authority);
  expect(await applyArtifactCatalogSnapshot(snapshot(2), authority)).toEqual({
    revision: 1,
    replayed: true,
  });
  expect(
    (await getPool().query("SELECT * FROM artifact_catalog_outbox")).rows,
  ).toHaveLength(1);
  const changed = snapshot(2);
  changed.items[0].title = "Conflicting retry";
  await expect(
    applyArtifactCatalogSnapshot(changed, authority),
  ).rejects.toThrow("sequence reused");
});
