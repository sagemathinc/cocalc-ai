/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID, createHash } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  registerCollaborationSource,
  ingestCollaborationSnapshot,
  getOwnedCollaborationResource,
} from "@cocalc/database/postgres/collaborators/collaborators-owner";
import {
  applyArtifactCatalogSnapshot,
  registerArtifactCatalogSource,
  readProjectArtifactCatalog,
  readArtifactCatalogEntry,
} from "@cocalc/database/postgres/artifact-catalog";
import { entryKey } from "@cocalc/database/postgres/collaborators/collaborators-common";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import type { ProjectCollaborationRehomePage } from "@cocalc/util/project-collaboration-rehome";
import {
  ensureProjectCollaborationRehomeSchema,
  freezeProjectCollaborationExport,
  readProjectCollaborationExportPage,
  prepareProjectCollaborationImport,
  receiveProjectCollaborationPage,
  activateProjectCollaborationImport,
} from "./collaboration-project-rehome";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" &&
  process.env.COCALC_DB === "pglite" &&
  process.env.COCALC_PGLITE_DATA_DIR === "memory://"
    ? describe
    : describe.skip;
const sourceBay = "preflight-source",
  destBay = "preflight-destination";
const originalBay = process.env.COCALC_BAY_ID;
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}

describeDb("collaboration rehome nonportable authority preflight", () => {
  beforeAll(async () => {
    process.env.COCALC_BAY_ID = sourceBay;
    await initEphemeralDatabase();
    await getPool().query(`CREATE TABLE project_rehome_operations (
      op_id UUID PRIMARY KEY,project_id UUID,source_bay_id TEXT,dest_bay_id TEXT,status TEXT,stage TEXT,created_at TIMESTAMPTZ DEFAULT now())`);
    await ensureProjectCollaborationRehomeSchema();
  }, 60_000);
  beforeEach(() => {
    process.env.COCALC_BAY_ID = sourceBay;
  });
  afterAll(async () => {
    if (originalBay === undefined) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = originalBay;
    await getPool().end();
  });
  async function fixture() {
    const project_id = randomUUID(),
      account_id = randomUUID(),
      host_id = randomUUID();
    const source = { project_id, chat_path: "/home/user/work.chat" };
    const authority = { owning_bay_id: sourceBay, host_id };
    const op = {
      op_id: randomUUID(),
      project_id,
      source_bay_id: sourceBay,
      dest_bay_id: destBay,
    };
    await getPool().query("INSERT INTO accounts(account_id) VALUES($1)", [
      account_id,
    ]);
    await getPool().query(
      "INSERT INTO projects(project_id,owning_bay_id,host_id,users) VALUES($1,$2,$3,$4::jsonb)",
      [
        project_id,
        sourceBay,
        host_id,
        JSON.stringify({ [account_id]: { group: "owner" } }),
      ],
    );
    const resource: CollaborationResource = {
      ...source,
      kind: "agent",
      resource_id: "agent-thread:thread",
      thread_id: "thread",
      title: "Research",
      activity: 1,
      participant_ids: [account_id],
      created_at: 1,
      updated_at: 1,
    };
    return { op, source, authority, account_id, resource };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function registerIdentity(
    f: Fixture,
    thread_id = "thread",
    history: string[] = [],
  ) {
    const agent_id = randomUUID();
    await getPool().query(
      `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by,conversation_history)
      VALUES($1,$2,$3,$4,'Registered research agent',$5,$6::jsonb)`,
      [
        agent_id,
        f.op.project_id,
        f.source.chat_path,
        thread_id,
        f.account_id,
        JSON.stringify(history.map((id) => ({ thread_id: id }))),
      ],
    );
    return agent_id;
  }
  async function ingest(f: Fixture, resource = f.resource) {
    const epoch = await registerCollaborationSource(
      f.source,
      f.authority,
      null,
      randomUUID(),
    );
    await ingestCollaborationSnapshot(
      { ...f.source, epoch, sequence: 1, resources: [resource] },
      f.authority,
    );
    return epoch;
  }
  async function artifact(f: Fixture) {
    const epoch = await registerArtifactCatalogSource(
      f.source,
      f.authority,
      null,
      randomUUID(),
    );
    await applyArtifactCatalogSnapshot(
      {
        ...f.source,
        schema_version: 1,
        epoch,
        sequence: 1,
        items: [
          {
            thread_id: "thread",
            artifact_id: "notes",
            kind: "file",
            title: "Notes",
            description: "",
            created_at: 1,
            publication: { operation_id: "publish", message_id: "message" },
            target: { path: "/home/user/notes.md" },
          },
        ],
      },
      f.authority,
    );
    return (await readProjectArtifactCatalog(f.op.project_id)).entries[0];
  }
  async function start(f: Fixture) {
    await getPool().query(
      "INSERT INTO project_rehome_operations(op_id,project_id,source_bay_id,dest_bay_id,status,stage) VALUES($1,$2,$3,$4,'running','requested')",
      [f.op.op_id, f.op.project_id, sourceBay, destBay],
    );
  }
  async function rejectedWithoutSnapshot(f: Fixture, dependency: string) {
    await start(f);
    await expect(freezeProjectCollaborationExport(f.op)).rejects.toThrow(
      dependency,
    );
    expect(
      (
        await getPool().query(
          "SELECT 1 FROM project_collaboration_rehome_transfers WHERE op_id=$1",
          [f.op.op_id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await getPool().query(
          "SELECT 1 FROM project_collaboration_rehome_pages WHERE project_id=$1",
          [f.op.project_id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await getPool().query(
          "SELECT owning_bay_id FROM projects WHERE project_id=$1",
          [f.op.project_id],
        )
      ).rows[0].owning_bay_id,
    ).toBe(sourceBay);
  }

  test("a genuinely registered collaboration agent is rejected before snapshot/freeze", async () => {
    const f = await fixture();
    const agent_id = await registerIdentity(f);
    const epoch = await ingest(f);
    const target = {
      project_id: f.op.project_id,
      kind: "agent" as const,
      resource_id: agent_id,
    };
    expect(
      await getOwnedCollaborationResource(target, f.account_id, f.authority),
    ).toMatchObject({ agent_id, resource_id: agent_id });
    await rejectedWithoutSnapshot(f, "nonportable agent_identities");
    expect(
      (
        await getPool().query(
          "SELECT epoch FROM collaboration_sources WHERE project_id=$1",
          [f.op.project_id],
        )
      ).rows[0].epoch,
    ).toBe(epoch);
    expect(
      (
        await getPool().query(
          "SELECT agent_id,disabled_at FROM agent_identities WHERE project_id=$1",
          [f.op.project_id],
        )
      ).rows,
    ).toEqual([{ agent_id, disabled_at: null }]);
  });
  test.each([false, true])(
    "pending registered-agent reconciliation (historical=%s) cannot escape preflight",
    async (historical) => {
      const f = await fixture();
      await ingest(f);
      await registerIdentity(
        f,
        historical ? "fresh-thread" : "thread",
        historical ? ["thread"] : [],
      );
      expect(
        (
          await getPool().query(
            "SELECT metadata FROM collaboration_catalog WHERE project_id=$1",
            [f.op.project_id],
          )
        ).rows[0].metadata.agent_id,
      ).toBeUndefined();
      await rejectedWithoutSnapshot(f, "nonportable agent_identities");
    },
  );
  test("a real artifact catalog resource is rejected without losing its Library authority", async () => {
    const f = await fixture();
    const entry = await artifact(f);
    const resource: CollaborationResource = {
      ...f.resource,
      kind: "artifact",
      resource_id: "artifact:notes",
      artifact_id: "notes",
      entry_id: entry.entry_id,
    };
    await ingest(f, resource);
    expect(
      await getOwnedCollaborationResource(resource, f.account_id, f.authority),
    ).toMatchObject({ kind: "artifact", entry_id: entry.entry_id });
    expect(
      await readArtifactCatalogEntry(f.op.project_id, entry.entry_id),
    ).toEqual(entry);
    await rejectedWithoutSnapshot(
      f,
      "nonportable artifact_catalog/artifact_catalog_sources",
    );
    expect(
      await readArtifactCatalogEntry(f.op.project_id, entry.entry_id),
    ).toEqual(entry);
  });
  test.each(["agent", "artifact"] as const)(
    "retained human state rejects live unindexed %s authority elsewhere in the project",
    async (kind) => {
      const f = await fixture();
      if (kind === "agent") await registerIdentity(f);
      else await artifact(f);
      await ingest(f, {
        ...f.resource,
        kind: "conversation",
        resource_id: "human-thread",
        thread_id: "human-thread",
      });
      expect(
        (
          await getPool().query(
            "SELECT kind FROM collaboration_catalog WHERE project_id=$1",
            [f.op.project_id],
          )
        ).rows,
      ).toEqual([{ kind: "conversation" }]);
      await rejectedWithoutSnapshot(
        f,
        kind === "agent"
          ? "nonportable agent_identities"
          : "nonportable artifact_catalog",
      );
    },
  );
  test("plain human collaboration without active nonportable authority is portable", async () => {
    const f = await fixture();
    await ingest(f, {
      ...f.resource,
      kind: "conversation",
      resource_id: "human-thread",
      thread_id: "human-thread",
    });
    await start(f);
    expect(await freezeProjectCollaborationExport(f.op)).toBeDefined();
  });
  test.each([false, true])(
    "unregistered agent threads remain portable (copy=%s)",
    async (copy) => {
      const f = await fixture();
      await ingest(f, {
        ...f.resource,
        resource_id: copy
          ? `copy:${randomUUID()}:agent:thread`
          : f.resource.resource_id,
      });
      await start(f);
      expect(await freezeProjectCollaborationExport(f.op)).toBeDefined();
    },
  );
  test("nonportable side tables alone do not change the legacy no-collaboration path", async () => {
    const f = await fixture();
    await registerIdentity(f);
    await artifact(f);
    await start(f);
    expect(await freezeProjectCollaborationExport(f.op)).toBeUndefined();
  });
  test("already unavailable tombstones do not introduce a new portability dependency", async () => {
    const f = await fixture();
    await registerIdentity(f);
    await ingest(f);
    await getPool().query(
      "UPDATE collaboration_catalog SET metadata=NULL,deleted_at=now() WHERE project_id=$1",
      [f.op.project_id],
    );
    await getPool().query(
      "UPDATE agent_identities SET disabled_at=now() WHERE project_id=$1",
      [f.op.project_id],
    );
    await start(f);
    expect(await freezeProjectCollaborationExport(f.op)).toBeDefined();
  });
  test("a copied agent resource does not hide its project's active registered identity", async () => {
    const f = await fixture();
    await registerIdentity(f);
    await ingest(f, {
      ...f.resource,
      resource_id: `copy:${randomUUID()}:agent:thread`,
    });
    await rejectedWithoutSnapshot(f, "nonportable agent_identities");
  });
  test("deleted artifact catalog entries do not block retained human state", async () => {
    const f = await fixture();
    await artifact(f);
    await getPool().query(
      "UPDATE artifact_catalog SET deleted=true WHERE project_id=$1",
      [f.op.project_id],
    );
    await ingest(f, { ...f.resource, kind: "conversation" });
    await start(f);
    expect(await freezeProjectCollaborationExport(f.op)).toBeDefined();
  });
  test("an older frozen export is rechecked before it can be resumed", async () => {
    const f = await fixture();
    await ingest(f);
    await start(f);
    await freezeProjectCollaborationExport(f.op);
    // Model an old sender's snapshot made before this preflight was deployed.
    const agent_id = await registerIdentity(f);
    await getPool().query(
      "UPDATE collaboration_catalog SET metadata=metadata || jsonb_build_object('agent_id',$2::text) WHERE project_id=$1",
      [f.op.project_id, agent_id],
    );
    await expect(freezeProjectCollaborationExport(f.op)).rejects.toThrow(
      "nonportable agent_identities",
    );
  });
  test.each(["agent", "artifact"] as const)(
    "destination rejects old staged %s authority before its project upsert",
    async (kind) => {
      const f = await fixture();
      const resource = {
        ...f.resource,
        kind: "conversation" as const,
        resource_id: "human-thread",
      };
      await ingest(f, resource);
      await start(f);
      const header = (await freezeProjectCollaborationExport(f.op))!;
      const pages: ProjectCollaborationRehomePage[] = [];
      let cursor: string | null = "0";
      while (cursor !== null) {
        const page = await readProjectCollaborationExportPage(header, cursor);
        pages.push(page);
        cursor = page.next;
      }
      // Construct a valid, hash-chained snapshot from an older sender which lacked
      // the authority preflight, not a corrupt page or unverified storage edit.
      const metadata = {
        ...resource,
        kind,
        ...(kind === "agent"
          ? { agent_id: randomUUID() }
          : { artifact_id: "notes", entry_id: "a".repeat(64) }),
      };
      const page = pages.find((p) => p.table === "collaboration_catalog")!;
      page.rows[0] = {
        ...page.rows[0],
        kind,
        metadata,
        entry_key: entryKey(metadata),
      };
      let previous = pages[0].previous_hash,
        bytes = 0;
      for (const p of pages) {
        p.previous_hash = previous;
        bytes += p.rows.reduce(
          (n, row) => n + Buffer.byteLength(canonical(row)),
          0,
        );
        if (p.manifest) p.manifest.bytes = bytes;
        const { hash: _hash, ...body } = p;
        p.hash = createHash("sha256").update(canonical(body)).digest("hex");
        previous = p.hash;
      }
      process.env.COCALC_BAY_ID = destBay;
      await prepareProjectCollaborationImport(header);
      for (const page of pages)
        await receiveProjectCollaborationPage(header, page);
      const db = await getPool().connect();
      const upsert = jest.fn(async () => {});
      try {
        await db.query("BEGIN");
        await expect(
          activateProjectCollaborationImport(db, header, upsert),
        ).rejects.toThrow("nonportable");
        expect(upsert).not.toHaveBeenCalled();
      } finally {
        await db.query("ROLLBACK");
        db.release();
      }
      expect(
        (
          await getPool().query(
            "SELECT metadata FROM collaboration_catalog WHERE entry_key=$1",
            [entryKey(resource)],
          )
        ).rows[0].metadata.kind,
      ).toBe("conversation");
      expect(
        (
          await getPool().query(
            "SELECT state FROM project_collaboration_rehome_transfers WHERE op_id=$1 AND direction='import'",
            [header.op_id],
          )
        ).rows[0].state,
      ).toBe("ready");
    },
  );
});
