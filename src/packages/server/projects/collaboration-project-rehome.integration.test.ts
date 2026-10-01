/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { MAX_PROJECT_NOTIFICATION_SUBSCRIPTIONS } from "@cocalc/database/postgres/collaborators/collaborators-subscription-store";
import { createHash, randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  syncCollaboratorsSchema,
  sourceKey,
  entryKey,
} from "@cocalc/database/postgres/collaborators/collaborators-common";
import { assertProjectNotRehoming } from "@cocalc/database/postgres/project-rehome-fence";
import {
  appendCollaborationNotificationEvents,
  readCollaborationNotificationObligation,
} from "@cocalc/database/postgres/collaborators/collaborators-notifications";
import {
  registerCollaborationSource,
  ingestCollaborationSnapshot,
} from "@cocalc/database/postgres/collaborators/collaborators-owner";
import { replaceCollaborationRoom } from "@cocalc/database/postgres/collaborators/collaborators-room-replacement";
import { PROJECT_COLLABORATION_REHOME_TABLES as TABLES } from "@cocalc/util/project-collaboration-rehome";
import type {
  ProjectCollaborationRehomeHeader as Header,
  ProjectCollaborationRehomePage as Page,
} from "@cocalc/util/project-collaboration-rehome";
import {
  ensureProjectCollaborationRehomeSchema as ensureSchema,
  freezeProjectCollaborationExport as freeze,
  readProjectCollaborationExportHeader as readHeader,
  readFrozenProjectCollaborationExport as frozen,
  readProjectCollaborationExportPage as readPage,
  prepareProjectCollaborationImport as prepare,
  receiveProjectCollaborationPage as receive,
  activateProjectCollaborationImport as activate,
  assertProjectCollaborationImportActive as assertActive,
  retireProjectCollaborationExport as retire,
  PAGE_BYTES,
  PAGE_ROWS,
  ROW_BYTES,
} from "./collaboration-project-rehome";

// Never run cleanup against inherited PostgreSQL or another worker's fixtures.
const describeDb =
  (process.env.COCALC_TEST_USE_PGLITE === "1" &&
    process.env.COCALC_PGLITE_DATA_DIR === "memory://") ||
  (!process.env.COCALC_TEST_USE_PGLITE &&
    process.env.COCALC_DB === "postgres" &&
    process.env.PGHOST?.startsWith("/tmp/collaborators-"))
    ? describe
    : describe.skip;
const sourceBay = "project-collaboration-source",
  destBay = "project-collaboration-destination";
const originalBay = process.env.COCALC_BAY_ID;
const high = 9007199254740993n;
async function tx<T>(fn: (db: any) => Promise<T>): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const value = await fn(db);
    await db.query("COMMIT");
    return value;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
function rehash(page: Page): Page {
  const { hash: _hash, ...body } = page;
  const value = JSON.stringify(body, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
  return { ...body, hash: createHash("sha256").update(value).digest("hex") };
}

describeDb(
  "bounded project-owned collaboration handoff (isolated database)",
  () => {
    beforeAll(async () => {
      await initEphemeralDatabase();
      // Exercise an upgraded, previously feature-disabled database, not only the
      // already-installed development schema. This process owns an ephemeral DB.
      await getPool().query(`DROP TABLE IF EXISTS ${TABLES.join(",")}`);
      await getPool()
        .query(`CREATE TABLE IF NOT EXISTS project_rehome_operations(
      op_id UUID PRIMARY KEY,project_id UUID,source_bay_id TEXT,dest_bay_id TEXT,status TEXT,stage TEXT,created_at TIMESTAMPTZ DEFAULT now())`);
      await ensureSchema();
      await syncCollaboratorsSchema();
    }, 60_000);
    beforeEach(async () => {
      process.env.COCALC_BAY_ID = sourceBay;
      await getPool()
        .query(`TRUNCATE project_collaboration_rehome_pages,project_collaboration_rehome_transfers,
      project_rehome_operations,${TABLES.join(",")},collaboration_personal,collaboration_access,
      collaboration_index,collaboration_participant_index,collaboration_relation_pages,collaboration_artifact_bindings,
      agent_personal_names,personal_library_aliases,personal_library_pins`);
    });
    afterAll(async () => {
      if (originalBay === undefined) delete process.env.COCALC_BAY_ID;
      else process.env.COCALC_BAY_ID = originalBay;
      await getPool().end();
    });
    async function fixture(count = 1, populated = true) {
      const op = {
        op_id: randomUUID(),
        project_id: randomUUID(),
        source_bay_id: sourceBay,
        dest_bay_id: destBay,
      };
      const actor = randomUUID(),
        account = randomUUID(),
        host = randomUUID(),
        room_id = randomUUID(),
        membership = randomUUID(),
        epoch = randomUUID(),
        generation = randomUUID();
      const source = {
        project_id: op.project_id,
        chat_path: "/home/user/.cocalc/collaborators.chat",
      };
      const source_id = sourceKey(source),
        relocated = sourceKey({ ...source, chat_path: "/home/user/old.chat" });
      const resource = {
        ...source,
        kind: "conversation" as const,
        resource_id: "thread-1",
        thread_id: "thread-1",
        title: "Retained discussion",
        activity: 40,
        participant_ids: [actor],
        created_at: 1,
        updated_at: 40,
      };
      const event = {
        version: 1 as const,
        project_id: op.project_id,
        room_id,
        thread_id: "thread-1",
        message_id: "pending-before-cutover",
        actor_account_id: actor,
        mentioned_account_ids: [account],
        mention_all: false,
        activity: 39,
        mode: "live" as const,
      };
      const event_id = randomUUID(),
        relocation_id = randomUUID();
      await getPool().query(
        "INSERT INTO accounts(account_id) VALUES($1),($2)",
        [actor, account],
      );
      await getPool().query(
        "INSERT INTO projects(project_id,owning_bay_id,host_id,users,title) VALUES($1,$2,$3,$4::jsonb,'Before cutover')",
        [
          op.project_id,
          sourceBay,
          host,
          JSON.stringify({
            [actor]: { group: "owner" },
            [account]: { group: "collaborator" },
          }),
        ],
      );
      if (populated) {
        await getPool().query(
          "INSERT INTO collaboration_projects(project_id,generation,revision,work_units,notification_due,notification_claim) VALUES($1,$2,73,19,now(),$2)",
          [op.project_id, generation],
        );
        await getPool().query(
          `INSERT INTO collaboration_sources(source_id,project_id,chat_path,owning_bay_id,writer_host_id,epoch,registration_id,source_sequence,revision,metadata_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,97,73,'retained-metadata')`,
          [
            source_id,
            op.project_id,
            source.chat_path,
            sourceBay,
            host,
            epoch,
            randomUUID(),
          ],
        );
        await getPool().query(
          `INSERT INTO collaboration_sources(source_id,project_id,chat_path,owning_bay_id,writer_host_id,epoch,relocated_to)
        VALUES($1,$2,'/home/user/old.chat',$3,$4,$5,$6)`,
          [relocated, op.project_id, sourceBay, host, randomUUID(), source_id],
        );
        for (let i = 1; i <= count; i++) {
          const r = {
            ...resource,
            resource_id: `thread-${i}`,
            thread_id: `thread-${i}`,
          };
          await getPool().query(
            `INSERT INTO collaboration_catalog(entry_key,source_id,project_id,kind,resource_id,metadata,artifact_entry_ids,agent_resource_ids,agent_source_activity,activity_floor,activity,revision)
          VALUES($1,$2,$3,'conversation',$4,$5::jsonb,'{old-artifact-locator}','{agent-thread:native,copy-operation:agent-thread:native}',$6::bigint,40,40,73)`,
            [
              entryKey(r),
              source_id,
              op.project_id,
              r.resource_id,
              JSON.stringify(r),
              String(high + 2n),
            ],
          );
        }
        await getPool().query(
          `INSERT INTO collaboration_catalog(entry_key,source_id,project_id,kind,resource_id,metadata,activity_floor,activity,revision,deleted_at)
        VALUES($1,$2,$3,'conversation','deleted-thread',NULL,99,99,70,now())`,
          [
            entryKey({ ...resource, resource_id: "deleted-thread" }),
            source_id,
            op.project_id,
          ],
        );
        await getPool().query(
          "INSERT INTO collaboration_rooms(project_id,room_id,chat_path,request_id,initialized) VALUES($1,$2,$3,$4,true)",
          [op.project_id, room_id, source.chat_path, randomUUID()],
        );
        await getPool().query(
          "INSERT INTO collaboration_memberships(project_id,account_id,epoch,notification_position) VALUES($1,$2,$3,$4::bigint),($1,$5,$6,0)",
          [
            op.project_id,
            account,
            membership,
            String(high - 1n),
            actor,
            randomUUID(),
          ],
        );
        await getPool().query(
          "INSERT INTO collaboration_notification_subscriptions(id,project_id,entry_key,account_id) VALUES($1,$2,$3,$4)",
          [entryKey(resource), op.project_id, entryKey(resource), account],
        );
        await getPool().query(
          "INSERT INTO collaboration_notification_events(event_id,project_id,generation,position,event_json,event_hash) VALUES($1,$2,$3,$4::bigint,$5::jsonb,'retained-event-hash')",
          [
            event_id,
            op.project_id,
            generation,
            String(high),
            JSON.stringify(event),
          ],
        );
        await getPool().query(
          "INSERT INTO collaboration_notification_floors(project_id,position) VALUES($1,$2::bigint)",
          [op.project_id, String(high - 10n)],
        );
        await getPool().query(
          "UPDATE collaboration_notification_events SET fanout_pending=TRUE,fanout_after=$2,fanout_due=now() WHERE event_id=$1",
          [event_id, account],
        );
        await getPool().query(
          "INSERT INTO collaboration_notification_recipients(id,event_id,project_id,account_id,membership_epoch) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), event_id, op.project_id, account, membership],
        );
        await getPool().query(
          "INSERT INTO collaboration_source_requests(project_id,chat_path,requested_by) VALUES($1,'/home/user/pending.chat',$2)",
          [op.project_id, account],
        );
        await getPool().query(
          "INSERT INTO collaboration_relocations(operation_id,project_id,request_hash,epoch,revision,created_at) VALUES($1,$2,'retained-request',$3,69,now())",
          [relocation_id, op.project_id, epoch],
        );
        await getPool().query(
          "INSERT INTO collaboration_personal(account_id,entry_key,project_id,read_through,notify_after,muted,collected,attention_generation) VALUES($1,$2,$3,37,5,true,true,$4)",
          [account, entryKey(resource), op.project_id, membership],
        );
        await getPool().query(
          "INSERT INTO collaboration_access(account_id,project_id,generation,granted_generation) VALUES($1,$2,$3,$3)",
          [account, op.project_id, generation],
        );
        await getPool().query(
          "INSERT INTO agent_personal_names(account_id,name,project_id,agent_id,metadata) VALUES($1,'copied-agent-alias',$2,$3,$4::jsonb)",
          [
            account,
            op.project_id,
            randomUUID(),
            JSON.stringify({ thread_id: "copy-operation:agent-thread:native" }),
          ],
        );
        await getPool().query(
          "INSERT INTO personal_library_aliases(account_id,name,project_id,entry_id) VALUES($1,'copied-artifact-alias',$2,'copy-operation:artifact:native')",
          [account, op.project_id],
        );
        await getPool().query(
          "INSERT INTO collaboration_artifact_bindings(account_id,entry_key,project_id,entry_id,pin_key) VALUES($1,$2,$3,'copy-operation:artifact:native','copied-pin')",
          [account, entryKey(resource), op.project_id],
        );
        const relation_set = createHash("sha256")
          .update(`set:${op.project_id}`)
          .digest("hex");
        const thread_key = createHash("sha256")
          .update("native-thread")
          .digest("hex");
        const reference = {
          kind: "reference",
          source: {
            kind: resource.kind,
            resource_id: resource.resource_id,
            thread_id: resource.thread_id,
          },
          message_id: "retained-source-message",
          reference: {
            version: 1,
            target: {
              project_id: op.project_id,
              kind: "artifact",
              resource_id: "copy-operation:artifact:native",
            },
          },
        };
        await getPool().query(
          "INSERT INTO collaboration_relation_sets(set_key,project_id,source_id,epoch,sequence,manifest,byte_count,row_count) VALUES($1,$2,$3,$4,97,$5::jsonb,1234,2)",
          [
            relation_set,
            op.project_id,
            source_id,
            epoch,
            JSON.stringify({
              version: 1,
              snapshot: { ...source, epoch, sequence: 97 },
              page_count: 1,
              participant_count: 1,
              reference_count: 1,
              byte_count: 1234,
              digest: "a".repeat(64),
            }),
          ],
        );
        await getPool().query(
          "INSERT INTO collaboration_participants(id,project_id,set_key,thread_key,participant_id) VALUES($1,$2,$3,$4,$5)",
          [
            `${relation_set}:participant`,
            op.project_id,
            relation_set,
            thread_key,
            actor,
          ],
        );
        await getPool().query(
          "INSERT INTO collaboration_references(id,project_id,set_key,thread_key,message_id,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
          [
            `${relation_set}:reference`,
            op.project_id,
            relation_set,
            thread_key,
            reference.message_id,
            JSON.stringify(reference),
          ],
        );
        await getPool().query(
          "UPDATE collaboration_sources SET relation_set=$2 WHERE source_id=$1",
          [source_id, relation_set],
        );
        await getPool().query(
          "UPDATE collaboration_catalog SET relation_set=$2,relation_thread=$3,relation_count=1 WHERE entry_key=$1",
          [entryKey(resource), relation_set, thread_key],
        );
        // Upload envelopes are operation-local, not portable canonical facts.
        await getPool().query(
          "INSERT INTO collaboration_relation_pages(id,project_id,set_key,page,payload,digest) VALUES($1,$2,$1,0,'{}'::jsonb,$3)",
          [relation_set, op.project_id, "b".repeat(64)],
        );
      }
      await getPool().query(
        "INSERT INTO project_rehome_operations(op_id,project_id,source_bay_id,dest_bay_id,status,stage) VALUES($1,$2,$3,$4,'running','requested')",
        [op.op_id, op.project_id, sourceBay, destBay],
      );
      return {
        op,
        source,
        source_id,
        relocated,
        resource,
        event,
        event_id,
        actor,
        account,
        host,
        room_id,
        membership,
        epoch,
        generation,
        relocation_id,
      };
    }
    async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
      const header = (await freeze(f.op))!;
      const pages: Page[] = [];
      let cursor: string | null = "0";
      while (cursor !== null) {
        const page = await readPage(header, cursor);
        pages.push(page);
        cursor = page.next;
      }
      return { header, pages };
    }
    async function stage(header: Header, pages: Page[]) {
      process.env.COCALC_BAY_ID = destBay;
      expect(await prepare(header)).toMatchObject({
        next: "0",
        complete: false,
        activated: false,
      });
      for (const page of pages) await receive(header, page);
    }
    async function activateFixture(
      f: Awaited<ReturnType<typeof fixture>>,
      header: Header,
    ) {
      return tx((db) =>
        activate(db, header, async () => {
          await db.query(
            "UPDATE projects SET owning_bay_id=$2,title='Destination' WHERE project_id=$1",
            [f.op.project_id, destBay],
          );
        }),
      );
    }

    test("replacement receipts and permanent retirement survive owner handoff and resume initialization", async () => {
      const f = await fixture();
      // The replacement precedes the requested handoff; no writes bypass its fence.
      await getPool().query(
        "UPDATE project_rehome_operations SET status='failed' WHERE op_id=$1",
        [f.op.op_id],
      );
      const request_id = randomUUID();
      const opts = {
        project_id: f.op.project_id,
        requesting_account_id: f.actor,
        request: {
          version: 1 as const,
          project_id: f.op.project_id,
          request_id,
          expected_room_id: f.room_id,
          expected_chat_path: f.source.chat_path,
        },
        absence: {
          status: "missing" as const,
          project_id: f.op.project_id,
          requesting_account_id: f.actor,
          host_id: f.host,
          request_id,
          room_id: f.room_id,
          chat_path: f.source.chat_path,
          source_epoch: f.epoch,
        },
      };
      const replaced = await replaceCollaborationRoom(opts, {
        owning_bay_id: sourceBay,
        host_id: f.host,
      });
      expect(replaced.outcome).toBe("pending");
      await getPool().query(
        "UPDATE project_rehome_operations SET status='running' WHERE op_id=$1",
        [f.op.op_id],
      );
      const { header, pages } = await snapshot(f);
      const receipt = pages.find(
        (page) => page.table === "collaboration_room_replacements",
      )!.rows[0];
      expect(receipt.operation_id).toBe(replaced.operation_id);
      const oldSource = pages
        .flatMap((page) =>
          page.table === "collaboration_sources" ? page.rows : [],
        )
        .find((row) => row.source_id === f.source_id)!;
      expect(oldSource.retired_room_id).toBe(f.room_id);
      await stage(header, pages);
      await activateFixture(f, header);
      process.env.COCALC_BAY_ID = sourceBay;
      await retire(header);
      process.env.COCALC_BAY_ID = destBay;
      await getPool().query(
        "UPDATE project_rehome_operations SET status='completed' WHERE op_id=$1",
        [f.op.op_id],
      );
      expect(
        (
          await getPool().query(
            "SELECT receipt FROM collaboration_room_replacements WHERE operation_id=$1",
            [replaced.operation_id],
          )
        ).rows[0].receipt,
      ).toEqual(receipt.receipt);
      expect(
        await replaceCollaborationRoom(
          { ...opts, absence: undefined },
          { owning_bay_id: destBay, host_id: f.host },
        ),
      ).toEqual(replaced);
      const source = (
        await getPool().query(
          "SELECT epoch,retired_room_id FROM collaboration_sources WHERE source_id=$1",
          [f.source_id],
        )
      ).rows[0];
      expect(source.retired_room_id).toBe(f.room_id);
      await expect(
        registerCollaborationSource(
          f.source,
          { owning_bay_id: destBay, host_id: f.host },
          source.epoch,
          randomUUID(),
        ),
      ).rejects.toThrow("retired");
    });

    test("maximum follower hints fit and survive project handoff", async () => {
      const f = await fixture();
      await getPool().query(
        `INSERT INTO collaboration_notification_subscriptions(id,project_id,entry_key,account_id)
         SELECT md5(n::text),$1,md5(n::text),$2 FROM generate_series(1,$3::int) n`,
        [
          f.op.project_id,
          f.account,
          MAX_PROJECT_NOTIFICATION_SUBSCRIPTIONS - 1,
        ],
      );
      const { header, pages } = await snapshot(f);
      const hints = pages.filter(
        (p) => p.table === "collaboration_notification_subscriptions",
      );
      expect(hints.reduce((n, p) => n + p.rows.length, 0)).toBe(
        MAX_PROJECT_NOTIFICATION_SUBSCRIPTIONS,
      );
      expect(Buffer.byteLength(JSON.stringify(hints))).toBeLessThan(
        4 * 1024 * 1024,
      );
      await stage(header, pages);
      await activateFixture(f, header);
      expect(
        Number(
          (
            await getPool().query(
              "SELECT count(*) AS n FROM collaboration_notification_subscriptions WHERE project_id=$1",
              [f.op.project_id],
            )
          ).rows[0].n,
        ),
      ).toBe(MAX_PROJECT_NOTIFICATION_SUBSCRIPTIONS);
    }, 60000);

    test("no collaboration state keeps the legacy path without installing a durable export", async () => {
      const f = await fixture(0, false);
      expect(await freeze(f.op)).toBeUndefined();
      expect(await frozen(f.op.project_id)).toBeUndefined();
    });
    test("installs missing canonical tables and indexed project-scoped staging cleanup", async () => {
      const fields = (
        await getPool().query(
          "SELECT column_name,is_nullable FROM information_schema.columns WHERE table_name='project_collaboration_rehome_pages' AND column_name='project_id'",
        )
      ).rows;
      expect(fields).toEqual([
        { column_name: "project_id", is_nullable: "NO" },
      ]);
      expect(
        (
          await getPool().query(
            "SELECT indexdef FROM pg_indexes WHERE tablename='project_collaboration_rehome_pages' AND indexname='project_collaboration_rehome_pages_project'",
          )
        ).rows[0].indexdef,
      ).toContain("(project_id)");
      expect(
        (
          await getPool().query(
            "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])",
            [[...TABLES]],
          )
        ).rows[0].n,
      ).toBe(TABLES.length);
      const f = await fixture();
      const other = await fixture();
      const { header, pages } = await snapshot(f);
      await snapshot(other);
      await stage(header, pages);
      expect(
        (
          await getPool().query(
            "SELECT DISTINCT project_id FROM project_collaboration_rehome_pages WHERE op_id=$1",
            [f.op.op_id],
          )
        ).rows,
      ).toEqual([{ project_id: f.op.project_id }]);
      // Both explicit project cleanup and FK cleanup are safe and project-scoped.
      await getPool().query(
        "DELETE FROM project_collaboration_rehome_pages WHERE project_id=$1 AND direction='export'",
        [f.op.project_id],
      );
      await getPool().query(
        "DELETE FROM project_collaboration_rehome_transfers WHERE project_id=$1",
        [f.op.project_id],
      );
      expect(
        (
          await getPool().query(
            "SELECT count(*)::int AS n FROM project_collaboration_rehome_pages WHERE project_id=$1",
            [f.op.project_id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await getPool().query(
            "SELECT count(*)::int AS n FROM project_collaboration_rehome_pages WHERE project_id=$1",
            [other.op.project_id],
          )
        ).rows[0].n,
      ).toBeGreaterThan(0);
    });
    test("all declared tables transfer losslessly; staging is invisible and activation retry cannot overwrite live state", async () => {
      const f = await fixture(61);
      const { header, pages } = await snapshot(f);
      expect(new Set(pages.map((p) => p.table))).toEqual(new Set(TABLES));
      expect(
        pages.every(
          (p) =>
            p.rows.length <= PAGE_ROWS &&
            Buffer.byteLength(JSON.stringify(p)) <= PAGE_BYTES,
        ),
      ).toBe(true);
      expect(
        pages.filter((p) => p.table === "collaboration_catalog"),
      ).toHaveLength(2);
      const event = pages.find(
        (p) => p.table === "collaboration_notification_events",
      )!.rows[0];
      expect(event.position).toBe(String(high));
      expect(event.fanout_pending).toBe(true);
      const scheduler = pages.find((p) => p.table === "collaboration_projects")!
        .rows[0];
      expect(scheduler.notification_claim).toBe(scheduler.generation);
      expect(scheduler.notification_due).toBeTruthy();
      expect(
        pages.find((p) => p.table === "collaboration_notification_recipients")!
          .rows,
      ).toHaveLength(1);
      expect(await freeze(f.op)).toEqual(header);
      expect(await readHeader(f.op.op_id)).toEqual(header);
      const home = (
        await getPool().query(
          "SELECT to_jsonb(p) AS value FROM collaboration_personal p WHERE project_id=$1",
          [f.op.project_id],
        )
      ).rows;
      const aliases: Record<string, unknown> = {};
      for (const table of [
        "agent_personal_names",
        "personal_library_aliases",
        "collaboration_artifact_bindings",
        "collaboration_access",
      ])
        aliases[table] = (
          await getPool().query(
            `SELECT to_jsonb(p) AS value FROM ${table} p WHERE project_id=$1`,
            [f.op.project_id],
          )
        ).rows;
      await stage(header, pages);
      expect(
        (
          await getPool().query(
            "SELECT owning_bay_id,title FROM projects WHERE project_id=$1",
            [f.op.project_id],
          )
        ).rows[0],
      ).toEqual({ owning_bay_id: sourceBay, title: "Before cutover" });
      expect(
        (
          await getPool().query(
            "SELECT epoch FROM collaboration_sources WHERE source_id=$1",
            [f.source_id],
          )
        ).rows[0].epoch,
      ).toBe(f.epoch);
      expect(await activateFixture(f, header)).toMatchObject({
        complete: true,
        activated: true,
        next: null,
      });
      const writer = (
        await getPool().query(
          "SELECT * FROM collaboration_sources WHERE source_id=$1",
          [f.source_id],
        )
      ).rows[0];
      expect(writer).toMatchObject({
        owning_bay_id: destBay,
        writer_host_id: null,
        registration_id: null,
        source_sequence: "0",
        metadata_hash: "retained-metadata",
      });
      expect(writer.epoch).not.toBe(f.epoch);
      const expectedSet = createHash("sha256")
        .update(`set:${f.op.project_id}`)
        .digest("hex");
      expect(writer.relation_set).toBe(expectedSet);
      expect(
        (
          await getPool().query(
            "SELECT participant_id FROM collaboration_participants WHERE set_key=$1",
            [expectedSet],
          )
        ).rows,
      ).toEqual([{ participant_id: f.actor }]);
      expect(
        (
          await getPool().query(
            "SELECT payload FROM collaboration_references WHERE set_key=$1",
            [expectedSet],
          )
        ).rows[0].payload,
      ).toMatchObject({
        message_id: "retained-source-message",
        source: { thread_id: f.resource.thread_id },
        reference: {
          target: { resource_id: "copy-operation:artifact:native" },
        },
      });
      expect(
        (
          await getPool().query(
            "SELECT relation_set,relation_count FROM collaboration_catalog WHERE entry_key=$1",
            [entryKey(f.resource)],
          )
        ).rows[0],
      ).toEqual({ relation_set: expectedSet, relation_count: "1" });
      expect(
        pages.some(
          (p) => (p.table as string) === "collaboration_relation_pages",
        ),
      ).toBe(false);
      expect(
        (
          await getPool().query(
            "SELECT generation FROM collaboration_projects WHERE project_id=$1",
            [f.op.project_id],
          )
        ).rows[0].generation,
      ).not.toBe(f.generation);
      expect(
        (
          await getPool().query(
            "SELECT room_id,initialized FROM collaboration_rooms WHERE project_id=$1",
            [f.op.project_id],
          )
        ).rows[0],
      ).toEqual({ room_id: f.room_id, initialized: true });
      expect(
        (
          await getPool().query(
            "SELECT epoch,notification_position::text FROM collaboration_memberships WHERE project_id=$1 AND account_id=$2",
            [f.op.project_id, f.account],
          )
        ).rows[0],
      ).toEqual({
        epoch: f.membership,
        notification_position: String(high - 1n),
      });
      expect(
        (
          await getPool().query(
            "SELECT position::text FROM collaboration_notification_events WHERE event_id=$1",
            [f.event_id],
          )
        ).rows[0].position,
      ).toBe(String(high));
      expect(
        (
          await getPool().query(
            "SELECT position::text FROM collaboration_notification_floors WHERE project_id=$1",
            [f.op.project_id],
          )
        ).rows[0].position,
      ).toBe(String(high - 10n));
      expect(
        (
          await getPool().query(
            "SELECT relocated_to FROM collaboration_sources WHERE source_id=$1",
            [f.relocated],
          )
        ).rows[0].relocated_to,
      ).toBe(f.source_id);
      expect(
        (
          await getPool().query(
            "SELECT activity_floor::text,metadata,deleted_at FROM collaboration_catalog WHERE project_id=$1 AND resource_id='deleted-thread'",
            [f.op.project_id],
          )
        ).rows[0],
      ).toMatchObject({
        activity_floor: "99",
        metadata: null,
        deleted_at: expect.any(Date),
      });
      expect(
        (
          await getPool().query(
            "SELECT requested_by FROM collaboration_source_requests WHERE project_id=$1",
            [f.op.project_id],
          )
        ).rows[0].requested_by,
      ).toBe(f.account);
      expect(
        (
          await getPool().query(
            "SELECT request_hash,epoch FROM collaboration_relocations WHERE operation_id=$1",
            [f.relocation_id],
          )
        ).rows[0],
      ).toEqual({ request_hash: "retained-request", epoch: f.epoch });
      expect(
        (
          await getPool().query(
            "SELECT to_jsonb(p) AS value FROM collaboration_personal p WHERE project_id=$1",
            [f.op.project_id],
          )
        ).rows,
      ).toEqual(home);
      for (const [table, rows] of Object.entries(aliases))
        expect(
          (
            await getPool().query(
              `SELECT to_jsonb(p) AS value FROM ${table} p WHERE project_id=$1`,
              [f.op.project_id],
            )
          ).rows,
        ).toEqual(rows);
      expect(
        (
          await getPool().query(
            "SELECT artifact_entry_ids,agent_resource_ids,agent_source_activity::text FROM collaboration_catalog WHERE entry_key=$1",
            [entryKey(f.resource)],
          )
        ).rows[0],
      ).toEqual({
        artifact_entry_ids: ["old-artifact-locator"],
        agent_resource_ids: [
          "agent-thread:native",
          "copy-operation:agent-thread:native",
        ],
        agent_source_activity: String(high + 2n),
      });
      expect(
        (
          await getPool().query(
            "SELECT count(*)::int AS n FROM project_collaboration_rehome_pages WHERE op_id=$1 AND direction='import' AND payload IS NOT NULL",
            [header.op_id],
          )
        ).rows[0].n,
      ).toBe(0);
      await getPool().query(
        "UPDATE projects SET title='Edited after cutover' WHERE project_id=$1",
        [f.op.project_id],
      );
      await getPool().query(
        "UPDATE collaboration_catalog SET activity=101 WHERE project_id=$1",
        [f.op.project_id],
      );
      const upsert = jest.fn(async () => {
        throw Error("must never replay the stale project snapshot");
      });
      await tx((db) => activate(db, header, upsert));
      expect(upsert).not.toHaveBeenCalled();
      expect(
        (
          await getPool().query(
            "SELECT title FROM projects WHERE project_id=$1",
            [f.op.project_id],
          )
        ).rows[0].title,
      ).toBe("Edited after cutover");
      expect(
        (
          await getPool().query(
            "SELECT min(activity)::text AS n FROM collaboration_catalog WHERE project_id=$1",
            [f.op.project_id],
          )
        ).rows[0].n,
      ).toBe("101");
      expect(await assertActive(getPool(), header)).toMatchObject({
        activated: true,
      });
      expect(await receive(header, pages[0])).toMatchObject({
        activated: true,
      });
      const conflicting = rehash({
        ...pages[0],
        rows: [{ ...pages[0].rows[0], work_units: "123" }],
      });
      await expect(receive(header, conflicting)).rejects.toThrow(
        /replay conflict/,
      );
    });

    test("missing, out-of-order, corrupt, foreign and replay-conflicting pages cannot activate", async () => {
      const f = await fixture();
      const { header, pages } = await snapshot(f);
      process.env.COCALC_BAY_ID = destBay;
      await prepare(header);
      const upsert = jest.fn(async () => {});
      await expect(tx((db) => activate(db, header, upsert))).rejects.toThrow(
        /incomplete/,
      );
      expect(upsert).not.toHaveBeenCalled();
      await expect(receive(header, pages[1])).rejects.toThrow(/order/);
      await expect(
        receive(header, { ...pages[0], hash: "0".repeat(64) }),
      ).rejects.toThrow(/hash/);
      const foreign = rehash({
        ...pages[0],
        rows: [{ ...pages[0].rows[0], project_id: randomUUID() }],
      });
      await expect(receive(header, foreign)).rejects.toThrow(/foreign/);
      await receive(header, pages[0]);
      expect(await receive(header, pages[0])).toMatchObject({ next: "1" });
      const conflict = rehash({
        ...pages[0],
        rows: [{ ...pages[0].rows[0], work_units: "123" }],
      });
      await expect(receive(header, conflict)).rejects.toThrow(
        /replay conflict/,
      );
      await expect(
        prepare({ ...header, schema_hash: "0".repeat(64) }),
      ).rejects.toThrow(/schema/);
      await expect(
        prepare({ ...header, project_id: randomUUID() }),
      ).rejects.toThrow(/conflict/);
    });
    test("activation rollback keeps the staged receipt retryable and invokes upsert again only before commit", async () => {
      const f = await fixture();
      const { header, pages } = await snapshot(f);
      await stage(header, pages);
      await expect(
        tx(async (db) => {
          await activate(db, header, async () => {
            await db.query(
              "UPDATE projects SET owning_bay_id=$2 WHERE project_id=$1",
              [f.op.project_id, destBay],
            );
          });
          throw Error("lost transaction");
        }),
      ).rejects.toThrow(/lost transaction/);
      expect(await prepare(header)).toMatchObject({
        complete: true,
        activated: false,
      });
      expect(await activateFixture(f, header)).toMatchObject({
        activated: true,
      });
    });
    test("failed exports remain durably fenced and resume the original immutable page prefix", async () => {
      const f = await fixture();
      await getPool().query(
        "UPDATE collaboration_catalog SET metadata=jsonb_build_object('huge',$2::text) WHERE project_id=$1 AND metadata IS NOT NULL",
        [f.op.project_id, "x".repeat(ROW_BYTES + 1)],
      );
      await expect(freeze(f.op)).rejects.toThrow(/capacity/);
      const header = (await frozen(f.op.project_id))!;
      expect(header.op_id).toBe(f.op.op_id);
      const prefix = (
        await getPool().query(
          "SELECT payload FROM project_collaboration_rehome_pages WHERE op_id=$1 AND direction='export' ORDER BY page",
          [f.op.op_id],
        )
      ).rows;
      expect(prefix).toHaveLength(2);
      await getPool().query(
        "UPDATE project_rehome_operations SET status='failed' WHERE op_id=$1",
        [f.op.op_id],
      );
      await expect(
        tx((db) =>
          assertProjectNotRehoming({ db, project_id: f.op.project_id }),
        ),
      ).rejects.toThrow(/rehome|handoff|frozen/);
      // Explicit fixture repair; ordinary owner writes must not bypass this fence.
      await getPool().query(
        "UPDATE collaboration_catalog SET metadata=$2::jsonb WHERE project_id=$1 AND metadata IS NOT NULL",
        [f.op.project_id, JSON.stringify(f.resource)],
      );
      expect(await freeze(f.op)).toEqual(header);
      expect(
        (
          await getPool().query(
            "SELECT payload FROM project_collaboration_rehome_pages WHERE op_id=$1 AND direction='export' AND page<2 ORDER BY page",
            [f.op.op_id],
          )
        ).rows,
      ).toEqual(prefix);
    });
    test("preserved high project positions append above retained history with a low global sequence and unchanged membership/readthrough", async () => {
      const f = await fixture();
      const { header, pages } = await snapshot(f);
      await stage(header, pages);
      await activateFixture(f, header);
      // Both logical bays share this isolated test DB. Retire its source half just
      // as the real source controller does after flipping its separate project row.
      process.env.COCALC_BAY_ID = sourceBay;
      await retire(header);
      expect(await readHeader(f.op.op_id)).toEqual(header);
      expect(
        (
          await getPool().query(
            "SELECT count(*)::int AS n FROM project_collaboration_rehome_pages WHERE op_id=$1 AND direction='export'",
            [header.op_id],
          )
        ).rows[0].n,
      ).toBe(0);
      await expect(readPage(header, "0")).rejects.toThrow(/unavailable/);
      await retire(header);
      expect(await frozen(f.op.project_id)).toBeUndefined();
      await getPool().query(
        "UPDATE project_rehome_operations SET status='succeeded' WHERE op_id=$1",
        [f.op.op_id],
      );
      process.env.COCALC_BAY_ID = destBay;
      const writer = (
        await getPool().query(
          "SELECT epoch FROM collaboration_sources WHERE source_id=$1",
          [f.source_id],
        )
      ).rows[0];
      await expect(
        ingestCollaborationSnapshot(
          {
            ...f.source,
            epoch: f.epoch,
            sequence: 98,
            resources: [f.resource],
          },
          { owning_bay_id: destBay, host_id: f.host },
        ),
      ).rejects.toThrow(/stale/);
      const epoch = await registerCollaborationSource(
        f.source,
        { owning_bay_id: destBay, host_id: f.host },
        writer.epoch,
        randomUUID(),
      );
      await getPool().query(
        "SELECT setval(pg_get_serial_sequence('collaboration_notification_events','position'),1,false)",
      );
      await tx((db) =>
        appendCollaborationNotificationEvents(
          db,
          {
            ...f.source,
            epoch,
            sequence: 1,
            resources: [f.resource],
            notification_events: [
              { ...f.event, message_id: "after-cutover", activity: 40 },
            ],
          },
          { owning_bay_id: destBay, host_id: f.host },
        ),
      );
      expect(
        (
          await getPool().query(
            "SELECT position::text FROM collaboration_notification_events WHERE project_id=$1 ORDER BY position",
            [f.op.project_id],
          )
        ).rows.map((r) => r.position),
      ).toEqual([String(high), String(high + 1n)]);
      const obligations = (
        await getPool().query(
          "SELECT id,project_id,account_id,membership_epoch FROM collaboration_notification_recipients WHERE project_id=$1",
          [f.op.project_id],
        )
      ).rows;
      expect(obligations).toHaveLength(1);
      const entry = await readCollaborationNotificationObligation(
        obligations[0],
        { owning_bay_id: destBay },
      );
      expect(entry?.event.message_id).toBe("pending-before-cutover");
      expect(entry?.attention.generation).toBe(f.membership);
      expect(
        (
          await getPool().query(
            "SELECT read_through::text,attention_generation FROM collaboration_personal WHERE project_id=$1",
            [f.op.project_id],
          )
        ).rows[0],
      ).toEqual({ read_through: "37", attention_generation: f.membership });
    });
  },
);
