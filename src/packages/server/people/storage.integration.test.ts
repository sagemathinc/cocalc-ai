/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import * as storageTransport from "@cocalc/conat/inter-bay/people-storage";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import type { PeopleAccessInvitation } from "@cocalc/util/people-invitation-history";
import type { PeopleInvitationOperation } from "@cocalc/util/people-invitations";
import { ensurePeopleSchema, ensurePeopleInviteSourceSchema } from "./schema";
import {
  ensurePeopleContactLocal,
  getPeopleContactLocal,
  listPeopleContactsLocal,
  archivePeopleContactLocal,
} from "./contacts";
import {
  applyAccessProjection,
  listInvitationHistoryLocal,
  getPeopleInvitationCountsLocal,
} from "./invite-projections";
import {
  recordPeopleInvitationOperation,
  drainPeopleCollaborationOutbox,
} from "./collaboration-projections";
import {
  backfillPeopleInvites,
  drainPeopleInviteOutbox,
} from "./invite-maintenance";
import {
  assertNoPeopleAccountStateForRehome,
  assertNoPeopleProjectStateForRehome,
  purgeDeletedPeopleAccounts,
} from "./rehome";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  getSecretSettingsKey: async () => Buffer.alloc(32, 7),
}));
jest.mock("@cocalc/server/projects/collaborators", () => ({
  ensureProjectCollabInviteEmailTokenSchema: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountsByIds: jest.fn(async (ids) =>
    ids.map((account_id) => ({
      account_id,
      display_name: "Public Person",
      email_address: "never-return-this@example.test",
    })),
  ),
  getClusterAccountById: jest.fn(async (account_id) => ({
    account_id,
    home_bay_id: process.env.COCALC_BAY_ID,
  })),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: jest.fn(async () => ({
    bay_id: process.env.COCALC_BAY_ID,
    epoch: 1,
  })),
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: jest.fn(() => false),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: jest.fn(async () => ({
    home_bay_id: process.env.COCALC_BAY_ID,
  })),
}));
jest.mock("@cocalc/database/postgres/account-rehome-fence", () =>
  jest.requireActual("../../database/postgres/account-rehome-fence"),
);

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("people contacts/lifecycle storage (isolated PostgreSQL)", () => {
  const priorBay = process.env.COCALC_BAY_ID;
  let sender: string, recipient: string, project: string;
  beforeAll(async () => {
    process.env.COCALC_BAY_ID = "people-test";
    await initEphemeralDatabase();
    await getPool().query(`ALTER TABLE project_collab_invites
      ADD COLUMN IF NOT EXISTS invite_source TEXT,ADD COLUMN IF NOT EXISTS accepted_account_id UUID,
      ADD COLUMN IF NOT EXISTS email_ciphertext TEXT,ADD COLUMN IF NOT EXISTS token_ciphertext TEXT,
      ADD COLUMN IF NOT EXISTS last_sent TIMESTAMP,ADD COLUMN IF NOT EXISTS resend_count INTEGER,
      ADD COLUMN IF NOT EXISTS scope TEXT,ADD COLUMN IF NOT EXISTS invite_role TEXT,ADD COLUMN IF NOT EXISTS read_policy JSONB`);
    await ensurePeopleSchema();
    await ensurePeopleInviteSourceSchema();
  }, 30000);
  beforeEach(async () => {
    process.env.COCALC_BAY_ID = "people-test";
    jest
      .mocked(getClusterAccountById)
      .mockImplementation(
        async (account_id) =>
          ({ account_id, home_bay_id: process.env.COCALC_BAY_ID }) as any,
      );
    jest
      .mocked(resolveProjectBay)
      .mockImplementation(
        async () => ({ bay_id: process.env.COCALC_BAY_ID, epoch: 1 }) as any,
      );
    jest.mocked(isMultiBayCluster).mockReturnValue(false);
    await getPool().query(
      "TRUNCATE people_contacts,people_invitation_index,people_account_state,people_collaboration_outbox,people_invite_outbox,project_collab_invites",
    );
    await getPool().query(
      "UPDATE people_invite_backfill SET after_id=NULL,complete=false",
    );
    sender = randomUUID();
    recipient = randomUUID();
    project = randomUUID();
    await getPool().query(
      "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,'people-test'),($2,'people-test')",
      [sender, recipient],
    );
    await getPool().query("INSERT INTO projects(project_id) VALUES($1)", [
      project,
    ]);
  });
  afterAll(async () => {
    if (priorBay === undefined) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = priorBay;
    await getPool().end();
  });
  function invitation(
    overrides: Partial<PeopleAccessInvitation> = {},
  ): PeopleAccessInvitation {
    return {
      invitation_id: randomUUID(),
      kind: "access",
      project_id: project,
      sender_account_id: sender,
      recipient_account_id: recipient,
      accepted_account_id: null,
      person_id: null,
      status: "pending",
      role: "collaborator",
      read_policy: null,
      message: "Discuss notebook",
      invite_source: "account",
      scope: "project_collab",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      expires_at: null,
      responded_at: null,
      last_sent_at: null,
      resend_count: 0,
      source_version: "1",
      source_bay_id: "people-test",
      ...overrides,
    };
  }
  async function apply(
    i: PeopleAccessInvitation,
    account_id = sender,
    deleted = false,
    contact_email?: string,
  ) {
    await applyAccessProjection({
      account_id,
      source_bay_id: "people-test",
      source_epoch: 1,
      invitation: i,
      deleted,
      contact_email,
    });
  }
  test("owner-private encrypted contacts, normalized dedup, no acceptance identity linkage, archive retains history", async () => {
    const a = await ensurePeopleContactLocal({
      account_id: sender,
      recipient: { email: "Person@EXAMPLE.test" },
    });
    const b = await ensurePeopleContactLocal({
      account_id: sender,
      recipient: { email: "person@example.test" },
    });
    expect(a.person_id).toBe(b.person_id);
    expect(a.linked_account_id).toBeNull();
    const stored = (
      await getPool().query(
        "SELECT * FROM people_contacts WHERE person_id=$1",
        [a.person_id],
      )
    ).rows[0];
    expect(JSON.stringify(stored)).not.toContain("person@example.test");
    expect(
      await getPeopleContactLocal({
        account_id: recipient,
        person_id: a.person_id,
      }),
    ).toBeNull();
    const i = invitation({
      invite_source: "email",
      recipient_account_id: null,
      status: "accepted",
      accepted_account_id: recipient,
    });
    await apply(i, sender, false, "person@example.test");
    expect(
      (await listInvitationHistoryLocal({ account_id: sender })).items[0]
        .recipient_label,
    ).toBe("person@example.test");
    await apply(i, recipient);
    expect(
      (
        await listInvitationHistoryLocal({
          account_id: recipient,
          view: "received",
        })
      ).items[0].recipient_label,
    ).toBeUndefined();
    expect(
      (
        await getPeopleContactLocal({
          account_id: sender,
          person_id: a.person_id,
        })
      )?.linked_account_id,
    ).toBeNull();
    await archivePeopleContactLocal({
      account_id: sender,
      person_id: a.person_id,
      archived: true,
    });
    expect((await listPeopleContactsLocal({ account_id: sender })).total).toBe(
      0,
    );
    expect(
      (
        await listInvitationHistoryLocal({
          account_id: sender,
          person_id: a.person_id,
        })
      ).total,
    ).toBe(1);
    expect(
      (
        await listPeopleContactsLocal({
          account_id: sender,
          include_archived: true,
          search: "person@example.test",
        })
      ).total,
    ).toBe(1);
  });
  test("monotonic events, duplicates, tombstones and stale owners", async () => {
    const i = invitation();
    await apply(i);
    const accepted = {
      ...i,
      source_version: "3",
      status: "accepted" as const,
      accepted_account_id: recipient,
    };
    await apply(accepted);
    await apply(i);
    await apply(accepted);
    expect(
      (await listInvitationHistoryLocal({ account_id: sender })).items[0]
        .status,
    ).toBe("accepted");
    expect(
      (await getPeopleInvitationCountsLocal({ account_id: sender })).pending
        .sent,
    ).toBe(0);
    await apply({ ...accepted, source_version: "4" }, sender, true);
    await apply(accepted);
    expect(
      (await listInvitationHistoryLocal({ account_id: sender })).total,
    ).toBe(0);
    await expect(
      applyAccessProjection({
        account_id: sender,
        invitation: i,
        source_bay_id: "old-owner",
        source_epoch: 1,
        deleted: false,
      }),
    ).rejects.toThrow("stale");
  });
  test("keyset pages have real totals, account/filter/revision-bound cursors and exact filters", async () => {
    for (let n = 0; n < 7; n++) await apply(invitation());
    const first = await listInvitationHistoryLocal({
      account_id: sender,
      limit: 2,
      search: "notebook",
      participant_account_id: recipient,
    });
    expect(first.total).toBe(7);
    expect(first.pending.sent).toBe(7);
    expect(first.items).toHaveLength(2);
    const second = await listInvitationHistoryLocal({
      account_id: sender,
      limit: 2,
      search: "notebook",
      participant_account_id: recipient,
      after: first.next,
    });
    expect(second.total).toBe(7);
    expect(
      new Set([...first.items, ...second.items].map((i) => i.invitation_id))
        .size,
    ).toBe(4);
    await expect(
      listInvitationHistoryLocal({ account_id: sender, after: first.next }),
    ).rejects.toThrow("cursor");
    await expect(
      listInvitationHistoryLocal({
        account_id: recipient,
        search: "notebook",
        participant_account_id: recipient,
        after: first.next,
      }),
    ).rejects.toThrow("cursor");
    expect(
      (
        await listInvitationHistoryLocal({
          account_id: sender,
          invitation_id: first.items[0].invitation_id,
        })
      ).total,
    ).toBe(1);
    await apply(invitation());
    await expect(
      listInvitationHistoryLocal({
        account_id: sender,
        search: "notebook",
        participant_account_id: recipient,
        after: first.next,
      }),
    ).rejects.toThrow("stale");
  });
  test("expiry changes counts without a browser owner fanout", async () => {
    await apply(invitation({ expires_at: "2000-01-01T00:00:00Z" }));
    const page = await listInvitationHistoryLocal({
      account_id: sender,
      view: "history",
    });
    expect(page.total).toBe(1);
    expect(page.items[0].status).toBe("expired");
    expect(page.pending.sent).toBe(0);
  });
  test("coverage reports the actual limitation and ignores other accounts' queued projections", async () => {
    const initial = await listInvitationHistoryLocal({ account_id: sender });
    expect(initial.coverage).toBe("partial");
    expect(initial.coverage_message).toContain("Older invitations");
    await backfillPeopleInvites();
    const observer = randomUUID();
    await getPool().query(
      "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,'people-test')",
      [observer],
    );
    await getPool().query(
      `INSERT INTO project_collab_invites(invite_id,project_id,inviter_account_id,invitee_account_id,status,created,updated)
      VALUES($1,$2,$3,$4,'pending',now(),now())`,
      [randomUUID(), project, sender, recipient],
    );
    for (const account_id of [sender, recipient]) {
      const queued = await listInvitationHistoryLocal({ account_id });
      expect(queued.coverage).toBe("partial");
      expect(queued.coverage_message).toContain(
        "1 invitation history update(s) for your account",
      );
    }
    expect(
      (await listInvitationHistoryLocal({ account_id: observer })).coverage,
    ).toBe("complete");
    await drainPeopleInviteOutbox();
    const settled = await listInvitationHistoryLocal({ account_id: sender });
    expect(settled.coverage).toBe("complete");
    expect(settled.coverage_message).toBeUndefined();
    jest.mocked(isMultiBayCluster).mockReturnValue(true);
    const unverified = await listInvitationHistoryLocal({ account_id: sender });
    expect(unverified.coverage).toBe("partial");
    expect(unverified.coverage_message).toContain(
      "Waiting or refreshing does not establish full coverage",
    );
  });

  test("canonical lifecycle transaction commits/rolls back with token-free outbox; bounded backfill and delivery", async () => {
    const id = randomUUID();
    const db = await getPool().connect();
    await db.query("BEGIN");
    await db.query(
      `INSERT INTO project_collab_invites(invite_id,project_id,inviter_account_id,invitee_account_id,status,created,updated,token_ciphertext)
      VALUES($1,$2,$3,$4,'pending',now(),now(),'secret-token-must-not-project')`,
      [id, project, sender, recipient],
    );
    expect(
      (
        await db.query(
          "SELECT version FROM people_invite_outbox WHERE invitation_id=$1",
          [id],
        )
      ).rows,
    ).toHaveLength(1);
    await db.query("ROLLBACK");
    db.release();
    expect(
      (await getPool().query("SELECT * FROM people_invite_outbox")).rows,
    ).toHaveLength(0);
    await getPool().query(
      `INSERT INTO project_collab_invites(invite_id,project_id,inviter_account_id,invitee_account_id,status,created,updated,token_ciphertext)
      VALUES($1,$2,$3,$4,'pending',now(),now(),'secret-token-must-not-project')`,
      [id, project, sender, recipient],
    );
    await getPool().query(
      "UPDATE project_collab_invites SET status='declined' WHERE invite_id=$1",
      [id],
    );
    const outbox = (await getPool().query("SELECT * FROM people_invite_outbox"))
      .rows[0];
    expect(`${outbox.version}`).toBe("2");
    expect(JSON.stringify(outbox.payload)).not.toContain("secret-token");
    await backfillPeopleInvites(1);
    await backfillPeopleInvites(1);
    expect(
      (await listInvitationHistoryLocal({ account_id: sender })).coverage,
    ).toBe("partial");
    expect(await drainPeopleInviteOutbox()).toBe(1);
    expect(
      (await listInvitationHistoryLocal({ account_id: sender })).coverage,
    ).toBe("complete");
    expect(
      (
        await listInvitationHistoryLocal({
          account_id: recipient,
          view: "received",
        })
      ).items[0].status,
    ).toBe("declined");
    await getPool().query(
      "DELETE FROM project_collab_invites WHERE invite_id=$1",
      [id],
    );
    await drainPeopleInviteOutbox();
    expect(
      (
        await listInvitationHistoryLocal({
          account_id: recipient,
          view: "received",
        })
      ).total,
    ).toBe(0);
  });
  test("collaboration delivery is independent, idempotent, and notification read/archive is recipient-only", async () => {
    const notice = randomUUID();
    const operation: PeopleInvitationOperation = {
      operation_id: randomUUID(),
      account_id: sender,
      draft_id: randomUUID(),
      revision: 1,
      payload: {
        recipient: { kind: "account", account_id: recipient },
        projects: [{ project_id: project, action: "notify" }],
        message: "A useful message",
        channels: { notification: true, email: false },
      },
      status: "complete",
      outcomes: [
        {
          child_operation_id: randomUUID(),
          project_id: project,
          action: "notify",
          status: "notified",
          collaboration_invitation_id: randomUUID(),
          delivery: [
            { channel: "notification", status: "queued", receipt_id: notice },
          ],
        },
      ],
      created_at: Date.now(),
      updated_at: Date.now(),
      source_version: 1,
      authorization_expires_at: Date.now() + 10000,
    };
    await recordPeopleInvitationOperation(operation);
    await recordPeopleInvitationOperation(operation);
    expect(await drainPeopleCollaborationOutbox()).toBe(1);
    expect(
      (
        await listInvitationHistoryLocal({
          account_id: recipient,
          view: "received",
          kind: "collaboration",
        })
      ).total,
    ).toBe(1);
    expect(
      (await getPeopleInvitationCountsLocal({ account_id: recipient })).unread,
    ).toBeNull();
    await getPool().query(
      `INSERT INTO account_notification_index(account_id,notification_id,kind,read_state,summary,created_at,updated_at)
      VALUES($1,$2,'account_notice','{}',jsonb_build_object('notice_type','collaboration_invitation','actor_account_id',$3::text),now(),now())`,
      [recipient, notice, sender],
    );
    expect(
      (await getPeopleInvitationCountsLocal({ account_id: recipient })).unread,
    ).toBe(1);
    await getPool().query(
      `UPDATE account_notification_index SET read_state='{"read":true,"archived":true}',updated_at=now() WHERE notification_id=$1`,
      [notice],
    );
    expect(
      (
        await listInvitationHistoryLocal({
          account_id: recipient,
          view: "received",
        })
      ).total,
    ).toBe(0);
    const history = await listInvitationHistoryLocal({
      account_id: recipient,
      view: "history",
    });
    expect(history.total).toBe(1);
    expect(history.unread).toBe(0);
    expect(history.items[0]).toMatchObject({
      notification_read: true,
      notification_archived: true,
    });
    expect(
      (await listInvitationHistoryLocal({ account_id: sender })).items[0],
    ).toMatchObject({ notification_read: null, notification_archived: null });
    expect(
      (await getPool().query("SELECT * FROM project_collab_invites")).rows,
    ).toHaveLength(0);
  });
  test("private records fail closed for rehome and soft deletion purges protected state", async () => {
    await ensurePeopleContactLocal({
      account_id: sender,
      recipient: { email: "private@example.test" },
    });
    await expect(
      assertNoPeopleAccountStateForRehome(getPool(), sender),
    ).rejects.toThrow("portability");
    await getPool().query(
      `INSERT INTO people_invite_outbox(invitation_id,project_id,version,payload) VALUES($1,$2,1,'{}')`,
      [randomUUID(), project],
    );
    await expect(
      assertNoPeopleProjectStateForRehome(getPool(), project),
    ).rejects.toThrow("portability");
    await getPool().query(
      "UPDATE accounts SET deleted=true WHERE account_id=$1",
      [sender],
    );
    expect(await purgeDeletedPeopleAccounts()).toBe(1);
    expect(
      (
        await getPool().query(
          "SELECT * FROM people_contacts WHERE account_id=$1",
          [sender],
        )
      ).rows,
    ).toHaveLength(0);
  });

  test("backfill is genuinely bounded and complete pagination reaches every old invitation", async () => {
    await getPool().query(
      "ALTER TABLE project_collab_invites DISABLE TRIGGER people_capture_access_invite",
    );
    try {
      const ids = Array.from({ length: 151 }, () => randomUUID());
      await getPool().query(
        `INSERT INTO project_collab_invites(invite_id,project_id,inviter_account_id,invitee_account_id,status,created,updated)
        SELECT unnest($1::uuid[]),$2,$3,$4,'accepted',now(),now()`,
        [ids, project, sender, recipient],
      );
    } finally {
      await getPool().query(
        "ALTER TABLE project_collab_invites ENABLE TRIGGER people_capture_access_invite",
      );
    }
    expect(await backfillPeopleInvites(100)).toBe(100);
    expect(
      (
        await getPool().query(
          "SELECT count(*)::int AS n FROM people_invite_outbox",
        )
      ).rows[0].n,
    ).toBe(100);
    expect(await backfillPeopleInvites(100)).toBe(51);
    await drainPeopleInviteOutbox(100);
    await drainPeopleInviteOutbox(100);
    let next: string | undefined;
    const ids = new Set<string>();
    do {
      const page = await listInvitationHistoryLocal({
        account_id: sender,
        view: "history",
        limit: 37,
        after: next,
      });
      expect(page.total).toBe(151);
      expect(page.coverage).toBe("complete");
      for (const i of page.items) {
        expect(ids.has(i.invitation_id)).toBe(false);
        ids.add(i.invitation_id);
      }
      next = page.next;
    } while (next);
    expect(ids.size).toBe(151);
  }, 30000);

  test("retargeted course rows retire the old recipient and retained tombstones survive ID reinsert", async () => {
    const id = randomUUID(),
      other = randomUUID();
    await getPool().query(
      "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,'people-test')",
      [other],
    );
    await getPool().query(
      `INSERT INTO project_collab_invites(invite_id,project_id,inviter_account_id,invitee_account_id,status,created,updated,scope)
      VALUES($1,$2,$3,$4,'pending',now(),now(),'course_student')`,
      [id, project, sender, recipient],
    );
    await drainPeopleInviteOutbox();
    await getPool().query(
      "UPDATE project_collab_invites SET invitee_account_id=$2 WHERE invite_id=$1",
      [id, other],
    );
    await drainPeopleInviteOutbox();
    expect(
      (
        await listInvitationHistoryLocal({
          account_id: recipient,
          view: "received",
        })
      ).total,
    ).toBe(0);
    expect(
      (
        await listInvitationHistoryLocal({
          account_id: other,
          view: "received",
        })
      ).total,
    ).toBe(1);
    await getPool().query(
      "DELETE FROM project_collab_invites WHERE invite_id=$1",
      [id],
    );
    await drainPeopleInviteOutbox();
    await getPool().query(
      `INSERT INTO project_collab_invites(invite_id,project_id,inviter_account_id,invitee_account_id,status,created,updated)
      VALUES($1,$2,$3,$4,'pending',now(),now())`,
      [id, project, sender, recipient],
    );
    await drainPeopleInviteOutbox();
    const page = await listInvitationHistoryLocal({
      account_id: recipient,
      view: "received",
    });
    expect(page.total).toBe(1);
    expect(page.items[0].source_version).toBe("4");
  });

  test("three-bay source delivery resolves both homes, retries outage, and does not claim global completeness", async () => {
    const id = randomUUID();
    const homes = new Map([
      [sender, "sender-home"],
      [recipient, "recipient-home"],
    ]);
    await getPool().query(
      "UPDATE accounts SET home_bay_id=CASE WHEN account_id=$1 THEN 'sender-home' ELSE 'recipient-home' END WHERE account_id=ANY($2::uuid[])",
      [sender, [sender, recipient]],
    );
    jest
      .mocked(getClusterAccountById)
      .mockImplementation(
        async (account_id) =>
          ({ account_id, home_bay_id: homes.get(account_id) }) as any,
      );
    jest
      .mocked(resolveProjectBay)
      .mockResolvedValue({ bay_id: "project-owner", epoch: 1 } as any);
    jest.mocked(isMultiBayCluster).mockReturnValue(true);
    process.env.COCALC_BAY_ID = "project-owner";
    await getPool().query(
      `INSERT INTO project_collab_invites(invite_id,project_id,inviter_account_id,invitee_account_id,status,created,updated)
      VALUES($1,$2,$3,$4,'pending',now(),now())`,
      [id, project, sender, recipient],
    );
    let outage = true;
    const routes: string[] = [];
    const rpc = jest
      .spyOn(storageTransport, "createInterBayPeopleStorageClient")
      .mockImplementation(
        ({ bay_id }) =>
          ({
            applyAccessProjection: async (event) => {
              routes.push(bay_id);
              if (outage && bay_id === "recipient-home")
                throw Error("simulated transport timeout");
              const previous = process.env.COCALC_BAY_ID;
              process.env.COCALC_BAY_ID = bay_id;
              try {
                await applyAccessProjection(event);
              } finally {
                process.env.COCALC_BAY_ID = previous;
              }
            },
          }) as any,
      );
    try {
      await drainPeopleInviteOutbox();
      expect(
        (
          await getPool().query(
            "SELECT delivered_at FROM people_invite_outbox WHERE invitation_id=$1",
            [id],
          )
        ).rows[0].delivered_at,
      ).toBeNull();
      outage = false;
      await getPool().query(
        "UPDATE people_invite_outbox SET available_at=now()",
      );
      await drainPeopleInviteOutbox();
      expect(routes).toEqual([
        "sender-home",
        "recipient-home",
        "sender-home",
        "recipient-home",
      ]);
      process.env.COCALC_BAY_ID = "recipient-home";
      expect(
        (
          await listInvitationHistoryLocal({
            account_id: recipient,
            view: "received",
          })
        ).coverage,
      ).toBe("partial");
      expect(
        (
          await listInvitationHistoryLocal({
            account_id: recipient,
            view: "received",
          })
        ).total,
      ).toBe(1);
      process.env.COCALC_BAY_ID = "sender-home";
      expect(
        (await listInvitationHistoryLocal({ account_id: sender })).total,
      ).toBe(1);
    } finally {
      rpc.mockRestore();
    }
  });

  test("access and collaboration IDs coexist; notification landing expands only authorized linked offers", async () => {
    const access = invitation(),
      second = invitation(),
      unrelated = invitation();
    for (const i of [access, second, unrelated]) {
      await apply(i);
      await apply(i, recipient);
    }
    const notice = randomUUID(),
      firstCollab = randomUUID(),
      secondCollab = randomUUID();
    const operation: PeopleInvitationOperation = {
      operation_id: randomUUID(),
      account_id: sender,
      draft_id: randomUUID(),
      revision: 1,
      payload: {
        recipient: { kind: "account", account_id: recipient },
        projects: [
          { project_id: project, action: "offer_access", role: "collaborator" },
        ],
        message: "Useful context",
        channels: { notification: true, email: false },
      },
      status: "complete",
      outcomes: [access, second].map((a, n) => ({
        child_operation_id: a.invitation_id,
        project_id: project,
        action: "offer_access",
        status: "created",
        access_invite_id: a.invitation_id,
        collaboration_invitation_id: n === 0 ? firstCollab : secondCollab,
        delivery: [
          { channel: "notification", status: "queued", receipt_id: notice },
        ],
      })),
      created_at: Date.now(),
      updated_at: Date.now(),
      source_version: 1,
      authorization_expires_at: Date.now() + 10000,
    };
    await recordPeopleInvitationOperation(operation);
    await drainPeopleCollaborationOutbox();
    const page = await listInvitationHistoryLocal({
      account_id: recipient,
      view: "received",
      invitation_id: firstCollab,
    });
    expect(page.total).toBe(4);
    expect(new Set(page.items.map((i) => i.invitation_id))).toEqual(
      new Set([
        access.invitation_id,
        second.invitation_id,
        firstCollab,
        secondCollab,
      ]),
    );
    expect(
      (await listInvitationHistoryLocal({ account_id: sender })).total,
    ).toBe(5);
    const stranger = randomUUID();
    await getPool().query(
      "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,'people-test')",
      [stranger],
    );
    expect(
      (
        await listInvitationHistoryLocal({
          account_id: stranger,
          view: "received",
          invitation_id: firstCollab,
        })
      ).total,
    ).toBe(0);
    const collision = {
      ...operation,
      outcomes: [
        {
          ...operation.outcomes[0],
          collaboration_invitation_id: access.invitation_id,
        },
      ],
    };
    await expect(recordPeopleInvitationOperation(collision)).rejects.toThrow(
      "kind collision",
    );
    expect(
      (
        await listInvitationHistoryLocal({
          account_id: sender,
          invitation_id: access.invitation_id,
        })
      ).items[0].kind,
    ).toBe("access");
  });

  test("account contacts have public labels but never inherit account email; shared-project exclusion is server-side", async () => {
    const c = await ensurePeopleContactLocal({
      account_id: sender,
      recipient: { account_id: recipient },
    });
    expect(c.display_label).toBe("Public Person");
    expect(c.email).toBeNull();
    expect(JSON.stringify(c)).not.toContain("never-return-this");
    await getPool().query(
      `INSERT INTO account_collaborator_index(account_id,collaborator_account_id,common_project_count,updated_at)
      VALUES($1,$2,1,now())`,
      [sender, recipient],
    );
    expect(
      (
        await listPeopleContactsLocal({
          account_id: sender,
          without_shared_projects: true,
        })
      ).total,
    ).toBe(0);
    expect((await listPeopleContactsLocal({ account_id: sender })).total).toBe(
      1,
    );
  });

  test("draft-only deleted accounts are purged without requiring a contact or projection", async () => {
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS people_invitation_drafts(account_id UUID,draft_id UUID)",
    );
    await getPool().query(
      "INSERT INTO people_invitation_drafts(account_id,draft_id) VALUES($1,$2)",
      [sender, randomUUID()],
    );
    await getPool().query(
      "UPDATE accounts SET deleted=true WHERE account_id=$1",
      [sender],
    );
    expect(
      (
        await getPool().query(
          "SELECT * FROM people_account_state WHERE account_id=$1",
          [sender],
        )
      ).rows,
    ).toHaveLength(0);
    expect(await purgeDeletedPeopleAccounts()).toBe(1);
    expect(
      (
        await getPool().query(
          "SELECT * FROM people_invitation_drafts WHERE account_id=$1",
          [sender],
        )
      ).rows,
    ).toHaveLength(0);
  });

  test("shared-project changes invalidate a filtered contact continuation", async () => {
    await ensurePeopleContactLocal({
      account_id: sender,
      recipient: { account_id: recipient },
    });
    await ensurePeopleContactLocal({
      account_id: sender,
      recipient: { email: "unlinked@example.test" },
    });
    const page = await listPeopleContactsLocal({
      account_id: sender,
      without_shared_projects: true,
      limit: 1,
    });
    expect(page.total).toBe(2);
    expect(page.next_cursor).toBeDefined();
    await getPool().query(
      `INSERT INTO account_collaborator_index(account_id,collaborator_account_id,common_project_count,updated_at)
      VALUES($1,$2,1,now())`,
      [sender, recipient],
    );
    await expect(
      listPeopleContactsLocal({
        account_id: sender,
        without_shared_projects: true,
        limit: 1,
        cursor: page.next_cursor,
      }),
    ).rejects.toThrow("stale");
  });
});
