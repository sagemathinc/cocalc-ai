/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash, randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { syncCollaboratorsSchema } from "@cocalc/database/postgres/collaborators-common";
import { initializeCollaborationProjectionAttention } from "@cocalc/database/postgres/collaborators-notifications";
import { assertAccountNotRehoming } from "@cocalc/database/postgres/account-rehome-fence";
import type {
  AccountCollaborationHandoff,
  AccountCollaborationPage,
} from "@cocalc/conat/inter-bay/api";
import {
  ensureCollaborationAccountRehomeSchema,
  collaborationRehomeTransaction as tx,
  freezeAccountCollaborationState as freeze,
  acceptAccountCollaborationState as accept,
  getAccountCollaborationPage,
  receiveAccountCollaborationPage as receive,
  importAccountCollaborationState as importState,
  activateAccountCollaborationState as activate,
  retireAccountCollaborationState as retire,
  assertNoCollaborationHandoff,
  COLLABORATION_REHOME_PAGE_BYTES,
} from "./collaboration-account-rehome";

jest.mock("@cocalc/database/postgres/account-rehome-fence", () =>
  jest.requireActual("../../database/postgres/account-rehome-fence"),
);

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
const source = "collaboration-rehome-source",
  destination = "collaboration-rehome-destination";
const originalBay = process.env.COCALC_BAY_ID;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
type Snapshot = {
  h: AccountCollaborationHandoff;
  pages: AccountCollaborationPage[];
  account: string;
  project: string;
  event: string;
  notification: string;
  generation: string;
};

describeDb("collaboration account-home transfer (isolated PGlite)", () => {
  beforeAll(async () => {
    await initEphemeralDatabase();
    await syncCollaboratorsSchema();
    await getPool().query(`CREATE TABLE IF NOT EXISTS account_rehome_operations(
      op_id UUID PRIMARY KEY,account_id UUID,source_bay_id TEXT,dest_bay_id TEXT,status TEXT,stage TEXT,created_at TIMESTAMPTZ DEFAULT now())`);
    await ensureCollaborationAccountRehomeSchema();
  }, 30000);
  beforeEach(async () => {
    process.env.COCALC_BAY_ID = source;
    // This suite is PGlite-only: these tables belong to its isolated in-memory DB.
    await getPool()
      .query(`TRUNCATE account_collaboration_handoffs,account_collaboration_rehome_pages,
      account_rehome_operations,collaboration_personal,collaboration_artifact_bindings,
      collaboration_notification_cursors,collaboration_account_state,collaboration_participant_index,collaboration_index,
      collaboration_access,notification_events,notification_targets,notification_target_outbox`);
  });
  afterAll(async () => {
    if (originalBay == null) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = originalBay;
    await getPool().end();
  });

  async function snapshot(count = 1, notifications = true): Promise<Snapshot> {
    const account = randomUUID(),
      project = randomUUID(),
      op_id = randomUUID();
    const generation = randomUUID(),
      event = randomUUID(),
      notification = randomUUID();
    await getPool().query(
      `INSERT INTO account_rehome_operations(op_id,account_id,source_bay_id,dest_bay_id,status,stage)
      VALUES($1,$2,$3,$4,'running','requested')`,
      [op_id, account, source, destination],
    );
    await getPool().query(
      `INSERT INTO collaboration_personal(account_id,entry_key,project_id,alias,collected,following,muted,
      read_through,notify_after,last_mention,attention_generation,following_explicit,muted_explicit,legacy_migrated)
      SELECT $1,r.entry_key,$2,r.alias,true,true,true,17,11,19,$3,true,true,true
      FROM jsonb_to_recordset($4::jsonb) AS r(entry_key text,alias text)`,
      [
        account,
        project,
        generation,
        JSON.stringify(
          Array.from({ length: count }, (_, i) => ({
            entry_key: digest(
              JSON.stringify([project, "conversation", `resource-${i + 1}`]),
            ),
            alias: `seminar-${i + 1}`,
          })),
        ),
      ],
    );
    await getPool().query(
      `INSERT INTO collaboration_artifact_bindings(account_id,entry_key,project_id,entry_id,pin_key)
      VALUES($1,$3,$2,'old-library-entry','stable-pin')`,
      [
        account,
        project,
        digest(JSON.stringify([project, "conversation", "resource-1"])),
      ],
    );
    await getPool().query(
      `INSERT INTO collaboration_notification_cursors(account_id,project_id,generation,cursor,claim_id,claim_until,failures,last_error)
      VALUES($1,$2,$3,'42', $4,now()+interval '1 day',7,'temporary failure')`,
      [account, project, generation, randomUUID()],
    );
    await getPool().query(
      `INSERT INTO collaboration_account_state(account_id,revision,revision_xid) VALUES($1,83,0)
      ON CONFLICT(account_id) DO UPDATE SET revision=83`,
      [account],
    );
    await getPool().query(
      `INSERT INTO collaboration_access(account_id,project_id,generation,granted_generation,grant_request_id,lease_until,complete)
      VALUES($1,$2,$3,$3,$4,now()+interval '1 day',true)`,
      [account, project, generation, randomUUID()],
    );
    const key = JSON.stringify([
      "collaboration-message-v1",
      project,
      "room",
      "thread",
      "message",
      account,
      "mention",
    ]);
    const entry_key = digest(
      JSON.stringify([project, "conversation", "resource-1"]),
    );
    await getPool().query(
      `INSERT INTO collaboration_index(account_id,entry_key,project_id,relation_set,relation_thread,relations_complete,relation_budget)
      VALUES($1,$2,$3,'active-set','native-thread',TRUE,2)`,
      [account, entry_key, project],
    );
    await getPool().query(
      `INSERT INTO collaboration_participant_index(account_id,entry_key,project_id,set_key,participant_id)
      VALUES($1,$2,$3,'active-set',$1),($1,$2,$3,'staged-set',$1)`,
      [account, entry_key, project],
    );
    await getPool().query(
      `INSERT INTO notification_events(event_id,kind,source_bay_id,source_project_id,payload_json)
      VALUES($1,'mention',$2,$3,$4)`,
      [event, source, project, { hash: "original-event-hash" }],
    );
    await getPool().query(
      `INSERT INTO notification_targets(event_id,target_account_id,target_home_bay_id,notification_id,dedupe_key)
      VALUES($1,$2,$3,$4,$5)`,
      [event, account, source, notification, key],
    );
    await getPool().query(
      `INSERT INTO notification_target_outbox(outbox_id,target_account_id,target_home_bay_id,notification_id,kind,event_type,payload_json)
      VALUES($1,$2,$3,$4,'mention','notification.upserted',$5)`,
      [randomUUID(), account, source, notification, { stable: "pending" }],
    );
    const h = await tx((db) =>
      freeze(
        db,
        {
          op_id,
          account_id: account,
          source_bay_id: source,
          dest_bay_id: destination,
        },
        notifications,
      ),
    );
    const pages: AccountCollaborationPage[] = [];
    for (let i = 0; i < h.page_count; i++)
      pages.push(await getAccountCollaborationPage(h, i));
    return { h, pages, account, project, event, notification, generation };
  }

  async function destinationDb(s: Snapshot) {
    // Model a distinct, empty destination using the same isolated SQL engine.
    await getPool()
      .query(`TRUNCATE account_collaboration_handoffs,account_collaboration_rehome_pages,
      collaboration_personal,collaboration_artifact_bindings,collaboration_notification_cursors,
      collaboration_account_state,notification_events,notification_targets,notification_target_outbox`);
    process.env.COCALC_BAY_ID = destination;
    await tx((db) => accept(db, s.h));
  }

  test("bounded pages preserve personal choices, floors, bindings, cursor and dedup; claims/grants do not migrate", async () => {
    const s = await snapshot(451);
    expect(
      s.pages.every(
        (p) => Buffer.byteLength(p.body) <= COLLABORATION_REHOME_PAGE_BYTES,
      ),
    ).toBe(true);
    expect(s.pages.every((p) => JSON.parse(p.body).rows.length <= 200)).toBe(
      true,
    );
    expect(
      s.pages.some((p) =>
        [
          "collaboration_access",
          "collaboration_index",
          "collaboration_participant_index",
        ].includes(JSON.parse(p.body).table),
      ),
    ).toBe(false);
    await destinationDb(s);
    for (const p of s.pages) await receive(s.h, p);
    await importState(s.h);
    expect(
      (
        await getPool().query(
          "SELECT * FROM collaboration_participant_index WHERE account_id=$1",
          [s.account],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await getPool().query(
          "SELECT * FROM collaboration_index WHERE account_id=$1",
          [s.account],
        )
      ).rows,
    ).toEqual([]);
    const personal = (
      await getPool().query(
        "SELECT * FROM collaboration_personal WHERE account_id=$1 ORDER BY entry_key",
        [s.account],
      )
    ).rows;
    expect(personal).toHaveLength(451);
    expect(personal.find((row) => row.alias === "seminar-1")).toMatchObject({
      alias: "seminar-1",
      collected: true,
      following: true,
      muted: true,
      read_through: "17",
      notify_after: "11",
      last_mention: "19",
      attention_generation: s.generation,
      following_explicit: true,
      muted_explicit: true,
      legacy_migrated: true,
    });
    expect(
      (await getPool().query("SELECT * FROM collaboration_artifact_bindings"))
        .rows[0],
    ).toMatchObject({ entry_id: "old-library-entry", pin_key: "stable-pin" });
    expect(
      (
        await getPool().query(
          "SELECT * FROM collaboration_notification_cursors",
        )
      ).rows[0],
    ).toMatchObject({
      cursor: "42",
      generation: s.generation,
      claim_id: null,
      claim_until: null,
      failures: "0",
      last_error: null,
    });
    expect(
      (await getPool().query("SELECT * FROM notification_events")).rows[0],
    ).toMatchObject({
      event_id: s.event,
      payload_json: { hash: "original-event-hash" },
    });
    expect(
      (await getPool().query("SELECT * FROM notification_targets")).rows[0],
    ).toMatchObject({
      notification_id: s.notification,
      target_home_bay_id: destination,
    });
    expect(
      (await getPool().query("SELECT * FROM notification_target_outbox")).rows,
    ).toHaveLength(0);
    await expect(
      tx((db) => assertAccountNotRehoming({ db, account_id: s.account })),
    ).rejects.toThrow("fenced");
    await activate(s.h);
    expect(
      (
        await getPool().query(
          "SELECT generation,granted_generation,grant_request_id,lease_until,complete FROM collaboration_access",
        )
      ).rows,
    ).toEqual([
      {
        generation: null,
        granted_generation: null,
        grant_request_id: null,
        lease_until: null,
        complete: false,
      },
    ]);
    await expect(
      tx((db) => assertAccountNotRehoming({ db, account_id: s.account })),
    ).rejects.toThrow("running");
    // The destination has no source coordinator operation in a real two-bay DB.
    await getPool().query(
      "DELETE FROM account_rehome_operations WHERE account_id=$1",
      [s.account],
    );
    await expect(
      tx((db) => assertAccountNotRehoming({ db, account_id: s.account })),
    ).resolves.toBeUndefined();
    expect(
      (await getPool().query("SELECT * FROM notification_target_outbox"))
        .rows[0],
    ).toMatchObject({
      notification_id: s.notification,
      target_home_bay_id: destination,
      published_at: null,
    });
    expect(
      Number(
        (
          await getPool().query(
            "SELECT revision FROM collaboration_account_state",
          )
        ).rows[0].revision,
      ),
    ).toBeGreaterThan(83);
    await tx((db) =>
      initializeCollaborationProjectionAttention(db, {
        account_id: s.account,
        project_id: s.project,
        generation: s.generation,
        resources: [
          {
            project_id: s.project,
            kind: "conversation",
            resource_id: "resource-1",
            title: "same membership after move",
            chat_path: "/home/user/a.chat",
            thread_id: randomUUID(),
            participant_ids: [],
            created_at: 1,
            updated_at: 200,
            activity: 200,
          },
        ],
      }),
    );
    expect(
      (
        await getPool().query(
          "SELECT read_through,notify_after FROM collaboration_personal WHERE alias='seminar-1'",
        )
      ).rows[0],
    ).toEqual({ read_through: "17", notify_after: "11" });
  });

  test("failed coordinator does not unfreeze source; raw maintenance and old source writes stay fenced after retirement", async () => {
    const s = await snapshot();
    await getPool().query(
      "UPDATE account_rehome_operations SET status='failed'",
    );
    await expect(
      tx((db) => assertAccountNotRehoming({ db, account_id: s.account })),
    ).rejects.toThrow("fenced");
    await expect(
      getPool().query(
        "UPDATE collaboration_personal SET alias='lost edit' WHERE account_id=$1",
        [s.account],
      ),
    ).rejects.toThrow("fenced");
    await expect(
      getPool().query(
        "DELETE FROM collaboration_notification_cursors WHERE account_id=$1",
        [s.account],
      ),
    ).rejects.toThrow("fenced");
    await expect(retire(s.h)).rejects.toThrow(
      "before destination copy acknowledgment",
    );
    await getPool().query(
      "UPDATE account_rehome_operations SET stage='projections_copied'",
    );
    await retire(s.h);
    await retire(s.h);
    expect(
      (await getPool().query("SELECT * FROM collaboration_personal")).rows,
    ).toHaveLength(0);
    await expect(
      getPool().query(
        "INSERT INTO collaboration_personal(account_id,entry_key,project_id) VALUES($1,'stale',$2)",
        [s.account, s.project],
      ),
    ).rejects.toThrow("fenced");
    await expect(assertNoCollaborationHandoff(s.account)).rejects.toThrow(
      "requires its collaboration handoff",
    );
  });

  test("accept/page/import/activation retries cannot overwrite post-cutover edits or resend an outbox", async () => {
    const s = await snapshot();
    await destinationDb(s);
    expect(await tx((db) => accept(db, s.h))).toBe(false);
    for (const p of s.pages) {
      await receive(s.h, p);
      await receive(s.h, p);
    }
    await importState(s.h);
    await importState(s.h);
    await activate(s.h);
    await getPool().query(
      "UPDATE collaboration_personal SET alias='new-home edit',read_through=40",
    );
    await getPool().query(
      "UPDATE notification_target_outbox SET published_at=now()",
    );
    await tx((db) => accept(db, s.h));
    for (const p of s.pages) await receive(s.h, p);
    await importState(s.h);
    await activate(s.h);
    expect(
      (
        await getPool().query(
          "SELECT alias,read_through FROM collaboration_personal",
        )
      ).rows[0],
    ).toEqual({ alias: "new-home edit", read_through: "40" });
    expect(
      (
        await getPool().query(
          "SELECT published_at FROM notification_target_outbox",
        )
      ).rows[0].published_at,
    ).not.toBeNull();
  });

  test("missing, reordered, corrupt and conflicting pages never unlock the destination", async () => {
    const s = await snapshot();
    await destinationDb(s);
    await expect(receive(s.h, s.pages[1])).rejects.toThrow("Out-of-order");
    await expect(importState(s.h)).rejects.toThrow("Incomplete");
    await expect(activate(s.h)).rejects.toThrow("not imported");
    await expect(
      receive(s.h, { ...s.pages[0], body: s.pages[0].body + " " }),
    ).rejects.toThrow("Invalid");
    await receive(s.h, s.pages[0]);
    const body = s.pages[0].body.replace("seminar", "altered");
    await expect(
      receive(s.h, { ...s.pages[0], body, hash: digest(body) }),
    ).rejects.toThrow("Conflicting");
    await expect(
      tx((db) => accept(db, { ...s.h, snapshot_hash: "a".repeat(64) })),
    ).rejects.toThrow("conflicts");
    await expect(
      getPool().query(
        "INSERT INTO collaboration_personal(account_id,entry_key) VALUES($1,'bypass')",
        [s.account],
      ),
    ).rejects.toThrow("fenced");
  });

  test("late import failure rolls back every personal row; retry imports the immutable snapshot", async () => {
    const s = await snapshot();
    await destinationDb(s);
    for (const p of s.pages) await receive(s.h, p);
    await getPool().query(
      "INSERT INTO notification_events(event_id,payload_json) VALUES($1,'{}')",
      [s.event],
    );
    await expect(importState(s.h)).rejects.toThrow("collision");
    expect(
      (await getPool().query("SELECT * FROM collaboration_personal")).rows,
    ).toHaveLength(0);
    expect(
      (
        await getPool().query(
          "SELECT state FROM account_collaboration_handoffs",
        )
      ).rows[0].state,
    ).toBe("accepted");
    await getPool().query("DELETE FROM notification_events WHERE event_id=$1", [
      s.event,
    ]);
    await importState(s.h);
    expect(
      (await getPool().query("SELECT * FROM collaboration_personal")).rows,
    ).toHaveLength(1);
  });

  test("source freeze rollback leaves neither a fence nor a partial snapshot", async () => {
    const account = randomUUID(),
      op_id = randomUUID();
    await getPool().query(
      "INSERT INTO account_rehome_operations(op_id,account_id,source_bay_id,dest_bay_id,status,stage) VALUES($1,$2,$3,$4,'running','requested')",
      [op_id, account, source, destination],
    );
    await expect(
      tx(async (db) => {
        await freeze(db, {
          op_id,
          account_id: account,
          source_bay_id: source,
          dest_bay_id: destination,
        });
        throw Error("abort creation");
      }),
    ).rejects.toThrow("abort creation");
    expect(
      (await getPool().query("SELECT * FROM account_collaboration_handoffs"))
        .rows,
    ).toHaveLength(0);
    expect(
      (
        await getPool().query(
          "SELECT * FROM account_collaboration_rehome_pages",
        )
      ).rows,
    ).toHaveLength(0);
    await getPool().query(
      "INSERT INTO collaboration_personal(account_id,entry_key) VALUES($1,'survives')",
      [account],
    );
  });

  test("oversized state aborts operation creation without discarding the original value", async () => {
    const account = randomUUID(),
      op_id = randomUUID(),
      alias = "x".repeat(COLLABORATION_REHOME_PAGE_BYTES + 1);
    await getPool().query(
      "INSERT INTO collaboration_personal(account_id,entry_key,alias) VALUES($1,'large',$2)",
      [account, alias],
    );
    await expect(
      tx(async (db) => {
        await db.query(
          "INSERT INTO account_rehome_operations(op_id,account_id,source_bay_id,dest_bay_id,status,stage) VALUES($1,$2,$3,$4,'running','requested')",
          [op_id, account, source, destination],
        );
        await freeze(db, {
          op_id,
          account_id: account,
          source_bay_id: source,
          dest_bay_id: destination,
        });
      }),
    ).rejects.toThrow("row exceeds page budget");
    expect(
      (await getPool().query("SELECT * FROM account_rehome_operations")).rows,
    ).toHaveLength(0);
    expect(
      (await getPool().query("SELECT * FROM account_collaboration_handoffs"))
        .rows,
    ).toHaveLength(0);
    expect(
      (await getPool().query("SELECT alias FROM collaboration_personal"))
        .rows[0].alias,
    ).toBe(alias);
  });

  test("return to a retired home replaces its receipt; stale old-operation RPCs are rejected", async () => {
    const s = await snapshot();
    await getPool().query(
      "UPDATE account_rehome_operations SET stage='projections_copied'",
    );
    await retire(s.h);
    const next = {
      ...s.h,
      op_id: randomUUID(),
      source_bay_id: destination,
      dest_bay_id: source,
    };
    await tx((db) => accept(db, next));
    for (const p of s.pages) await receive(next, p);
    await importState(next);
    await activate(next);
    process.env.COCALC_BAY_ID = destination;
    await expect(receive(s.h, s.pages[0])).rejects.toThrow("conflicts");
    process.env.COCALC_BAY_ID = source;
    expect(
      (await getPool().query("SELECT alias FROM collaboration_personal"))
        .rows[0].alias,
    ).toBe("seminar-1");
  });

  test("financial protocol remains sole owner of its notification graph when enabled", async () => {
    const s = await snapshot(1, false);
    expect(s.pages.map((p) => JSON.parse(p.body).table)).not.toContain(
      "notification_events",
    );
    expect(s.pages.map((p) => JSON.parse(p.body).table)).toContain(
      "collaboration_notification_cursors",
    );
  });
});
