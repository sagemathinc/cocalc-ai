/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { send_invite_email } from "@cocalc/server/hub/email";
import {
  assertCanManageProjectCollaborators,
  canSendInviteEmail,
  decryptInviteValue,
} from "./collaborators";
import {
  ensurePeopleInviteResendSchema,
  resendPeopleInviteLocal,
} from "./people-invite-resend";

let previousSend: Date | undefined;
let settings: Record<string, string> | undefined;
const recorded = jest.fn();
jest.mock("@cocalc/database", () => ({
  db: () => ({
    when_sent_project_invite: ({ cb }) => cb(undefined, previousSend),
    get_server_settings_cached: ({ cb }) => cb(undefined, settings),
    sent_project_invite: ({ cb, ...opts }) => {
      recorded(opts);
      cb();
    },
  }),
}));
jest.mock("@cocalc/server/hub/email", () => ({ send_invite_email: jest.fn() }));
jest.mock("./collaborators", () => ({
  ensureProjectCollabInviteEmailTokenSchema: jest.fn(async () => {}),
  assertCanManageProjectCollaborators: jest.fn(
    async ({ account_id, project_id }) => {
      const { rows } = await getPool().query(
        `SELECT users->$2::text->>'group' AS role, manage_users_owner_only FROM projects WHERE project_id=$1`,
        [project_id, account_id],
      );
      if (
        rows[0]?.role !== "owner" &&
        (rows[0]?.role !== "collaborator" || rows[0]?.manage_users_owner_only)
      )
        throw Error("management denied");
    },
  ),
  canSendInviteEmail: jest.fn(async () => true),
  getInvitePolicyAccountId: jest.fn(async ({ account_id }) => account_id),
  getInviteEmailResendCutoff: jest.fn(
    async () => new Date(Date.now() - 60_000),
  ),
  decryptInviteValue: jest.fn(async (_aad, value) =>
    value === "encrypted-token" ? "same-token" : "recipient@example.test",
  ),
  inviteUrl: jest.fn(
    async ({ token }) => `https://example.test/invites/${token}`,
  ),
  allowUrlsInEmails: jest.fn(async () => true),
  emailUnavailableFromSendMessage: jest.fn((msg) => msg.includes("configured")),
}));

beforeAll(async () => {
  await initEphemeralDatabase();
  await ensurePeopleInviteResendSchema();
}, 30000);
afterAll(async () => {
  await getPool().end();
});
beforeEach(() => {
  jest.clearAllMocks();
  previousSend = undefined;
  settings = {
    organization_email: "noreply@example.test",
    organization_name: "CoCalc",
  };
  jest.mocked(canSendInviteEmail).mockResolvedValue(true);
  jest.mocked(send_invite_email).mockImplementation(({ cb }) => cb());
});

async function fixture() {
  const opts = {
    account_id: randomUUID(),
    project_id: randomUUID(),
    invite_id: randomUUID(),
    operation_id: randomUUID(),
  };
  await getPool().query(`INSERT INTO accounts(account_id) VALUES ($1)`, [
    opts.account_id,
  ]);
  await getPool().query(
    `INSERT INTO projects(project_id,users,owning_bay_id)
    VALUES ($1,$2::jsonb,$3)`,
    [
      opts.project_id,
      JSON.stringify({ [opts.account_id]: { group: "owner" } }),
      getConfiguredBayId(),
    ],
  );
  await getPool().query(
    `INSERT INTO project_collab_invites
    (project_id,invite_id,inviter_account_id,status,invite_source,scope,created,updated,email_ciphertext,token_ciphertext,token_hash,message)
    VALUES ($1,$2,$3,'pending','email','project_collab',NOW(),NOW(),'encrypted-email','encrypted-token','unchanged-hash','Please collaborate.')`,
    [opts.project_id, opts.invite_id, opts.account_id],
  );
  return opts;
}

it("resends the exact existing bearer link once and replays a durable receipt", async () => {
  const opts = await fixture();
  const first = await resendPeopleInviteLocal(opts);
  expect(first).toEqual({
    project_id: opts.project_id,
    invite_id: opts.invite_id,
    operation_id: opts.operation_id,
    status: "sent",
    email_sent: true,
  });
  expect(await resendPeopleInviteLocal(opts)).toEqual(first);
  expect(send_invite_email).toHaveBeenCalledTimes(1);
  expect(send_invite_email).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "recipient@example.test",
      link2proj: "https://example.test/invites/same-token",
      email: "Please collaborate.",
    }),
  );
  const legacy = await getPool().query(
    "SELECT invite FROM projects WHERE project_id=$1",
    [opts.project_id],
  );
  expect(legacy.rows[0].invite["recipient@example.test"].time).toBeTruthy();
  const { rows } = await getPool().query(
    `SELECT invite_id,token_ciphertext,token_hash,resend_count,last_sent FROM project_collab_invites WHERE project_id=$1`,
    [opts.project_id],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    invite_id: opts.invite_id,
    token_ciphertext: "encrypted-token",
    token_hash: "unchanged-hash",
    resend_count: 1,
  });
  expect(rows[0].last_sent).toBeTruthy();
  expect(JSON.stringify(first)).not.toMatch(/recipient@|same-token|encrypted/);
});

it("rechecks management on receipt inspection after permission loss", async () => {
  const opts = await fixture();
  await resendPeopleInviteLocal(opts);
  await getPool().query(
    `UPDATE projects SET users=$2::jsonb,manage_users_owner_only=true WHERE project_id=$1`,
    [
      opts.project_id,
      JSON.stringify({ [opts.account_id]: { group: "collaborator" } }),
    ],
  );
  await expect(resendPeopleInviteLocal(opts)).rejects.toThrow(
    "management denied",
  );
  expect(send_invite_email).toHaveBeenCalledTimes(1);
  expect(assertCanManageProjectCollaborators).toHaveBeenCalled();
});

it("rejects mismatched project/invite and operation rebinding before email", async () => {
  const opts = await fixture();
  const other = await fixture();
  await expect(
    resendPeopleInviteLocal({ ...opts, invite_id: other.invite_id }),
  ).rejects.toThrow("specified project");
  expect(send_invite_email).not.toHaveBeenCalled();
  await resendPeopleInviteLocal(opts);
  const invite_id = randomUUID();
  await getPool().query(
    `INSERT INTO project_collab_invites(invite_id,project_id,inviter_account_id,status,created,updated) VALUES ($1,$2,$3,'pending',NOW(),NOW())`,
    [invite_id, opts.project_id, opts.account_id],
  );
  await expect(resendPeopleInviteLocal({ ...opts, invite_id })).rejects.toThrow(
    "already bound",
  );
  expect(send_invite_email).toHaveBeenCalledTimes(1);
});

it.each(["accepted", "declined", "canceled", "blocked", "expired"])(
  "never resends a %s invitation",
  async (status) => {
    const opts = await fixture();
    await getPool().query(
      `UPDATE project_collab_invites SET status=$2 WHERE invite_id=$1`,
      [opts.invite_id, status],
    );
    expect(await resendPeopleInviteLocal(opts)).toMatchObject({
      status: "not_sent",
      reason: "not_pending",
      email_sent: false,
    });
    expect(send_invite_email).not.toHaveBeenCalled();
  },
);

it("checks natural expiry without extending the invitation lifetime", async () => {
  const opts = await fixture();
  await getPool().query(
    `UPDATE project_collab_invites SET created=NOW()-INTERVAL '15 days' WHERE invite_id=$1`,
    [opts.invite_id],
  );
  expect(await resendPeopleInviteLocal(opts)).toMatchObject({
    status: "not_sent",
    reason: "expired",
  });
  expect(decryptInviteValue).not.toHaveBeenCalled();
});

it("uses both legacy recipient cooldown and canonical last_sent", async () => {
  const opts = await fixture();
  previousSend = new Date();
  expect(await resendPeopleInviteLocal(opts)).toMatchObject({
    status: "not_sent",
    reason: "cooldown",
  });
  previousSend = undefined;
  expect(await resendPeopleInviteLocal(opts)).toMatchObject({
    reason: "cooldown",
  });
  await getPool().query(
    `UPDATE project_collab_invites SET last_sent=NOW() WHERE invite_id=$1`,
    [opts.invite_id],
  );
  expect(
    await resendPeopleInviteLocal({ ...opts, operation_id: randomUUID() }),
  ).toMatchObject({ reason: "cooldown" });
  expect(send_invite_email).not.toHaveBeenCalled();
});

it("reports tier or mail configuration suppression without claiming a send", async () => {
  const opts = await fixture();
  jest.mocked(canSendInviteEmail).mockResolvedValue(false);
  expect(await resendPeopleInviteLocal(opts)).toMatchObject({
    reason: "tier_disallows_email",
    email_sent: false,
  });
  jest.mocked(canSendInviteEmail).mockResolvedValue(true);
  settings = undefined;
  expect(
    await resendPeopleInviteLocal({ ...opts, operation_id: randomUUID() }),
  ).toMatchObject({ reason: "email_not_configured", email_sent: false });
  expect(send_invite_email).not.toHaveBeenCalled();
});

it("retains unknown after provider exception and never resubmits even with a new operation", async () => {
  const opts = await fixture();
  jest
    .mocked(send_invite_email)
    .mockImplementation(({ cb }) => cb(Error("provider outcome ambiguous")));
  const first = await resendPeopleInviteLocal(opts);
  expect(first).toMatchObject({
    status: "unknown",
    email_sent: null,
    reason: "delivery_unknown",
  });
  expect(await resendPeopleInviteLocal(opts)).toEqual(first);
  expect(
    await resendPeopleInviteLocal({ ...opts, operation_id: randomUUID() }),
  ).toMatchObject({
    status: "not_sent",
    reason: "cooldown",
    email_sent: false,
  });
  expect(send_invite_email).toHaveBeenCalledTimes(1);
  expect(recorded).not.toHaveBeenCalled();
});

it("returns unsupported for account invitations without manufacturing delivery", async () => {
  const opts = await fixture();
  await getPool().query(
    `UPDATE project_collab_invites SET invite_source='account' WHERE invite_id=$1`,
    [opts.invite_id],
  );
  expect(await resendPeopleInviteLocal(opts)).toMatchObject({
    status: "not_sent",
    reason: "unsupported_invite",
  });
  expect(send_invite_email).not.toHaveBeenCalled();
});

it("serializes concurrent retry calls and sends only once", async () => {
  const opts = await fixture();
  await Promise.all([
    resendPeopleInviteLocal(opts),
    resendPeopleInviteLocal(opts),
  ]);
  expect(await resendPeopleInviteLocal(opts)).toMatchObject({
    status: "sent",
    email_sent: true,
  });
  expect(send_invite_email).toHaveBeenCalledTimes(1);
});

it("serializes different resend IDs against the same invite cooldown", async () => {
  const opts = await fixture();
  const receipts = await Promise.all([
    resendPeopleInviteLocal(opts),
    resendPeopleInviteLocal({ ...opts, operation_id: randomUUID() }),
  ]);
  expect(receipts.map(({ status }) => status).sort()).toEqual([
    "not_sent",
    "sent",
  ]);
  expect(send_invite_email).toHaveBeenCalledTimes(1);
});

it("records provider suppression and does not update successful-send counters", async () => {
  const opts = await fixture();
  jest
    .mocked(send_invite_email)
    .mockImplementation(({ cb }) => cb(undefined, "email not configured"));
  expect(await resendPeopleInviteLocal(opts)).toMatchObject({
    status: "not_sent",
    reason: "email_not_configured",
    email_sent: false,
  });
  expect(await resendPeopleInviteLocal(opts)).toMatchObject({
    status: "not_sent",
  });
  expect(send_invite_email).toHaveBeenCalledTimes(1);
  expect(
    (
      await getPool().query(
        "SELECT last_sent,resend_count FROM project_collab_invites WHERE invite_id=$1",
        [opts.invite_id],
      )
    ).rows[0],
  ).toEqual({ last_sent: null, resend_count: null });
});

it("keeps the committed unknown receipt if database finalization fails after submission", async () => {
  const opts = await fixture();
  await getPool()
    .query(`CREATE FUNCTION fail_resend_finalize() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated finalization failure'; END; $$`);
  await getPool()
    .query(`CREATE TRIGGER fail_resend_finalize BEFORE UPDATE ON project_collab_invites
    FOR EACH ROW WHEN (NEW.last_sent IS DISTINCT FROM OLD.last_sent) EXECUTE FUNCTION fail_resend_finalize()`);
  try {
    await expect(resendPeopleInviteLocal(opts)).rejects.toThrow(
      "simulated finalization failure",
    );
    expect(await resendPeopleInviteLocal(opts)).toMatchObject({
      status: "unknown",
      email_sent: null,
    });
    expect(send_invite_email).toHaveBeenCalledTimes(1);
    expect(
      (
        await getPool().query(
          "SELECT last_sent FROM project_collab_invites WHERE invite_id=$1",
          [opts.invite_id],
        )
      ).rows[0].last_sent,
    ).toBeNull();
  } finally {
    await getPool().query(
      "DROP TRIGGER fail_resend_finalize ON project_collab_invites",
    );
    await getPool().query("DROP FUNCTION fail_resend_finalize()");
  }
});

it("fences project rehome while receipts exist and cascades receipt deletion with the project", async () => {
  const opts = await fixture();
  await resendPeopleInviteLocal(opts);
  const { assertNoPeopleProjectStateForRehome } =
    await import("@cocalc/server/people/rehome");
  await expect(
    assertNoPeopleProjectStateForRehome(getPool(), opts.project_id),
  ).rejects.toThrow("rehome");
  await getPool().query("DELETE FROM projects WHERE project_id=$1", [
    opts.project_id,
  ]);
  expect(
    (
      await getPool().query(
        "SELECT 1 FROM people_invite_resend_operations WHERE project_id=$1",
        [opts.project_id],
      )
    ).rows,
  ).toEqual([]);
});

it("rejects a stale owning-bay route and deleted projects", async () => {
  const opts = await fixture();
  await getPool().query(
    `UPDATE projects SET owning_bay_id='other-bay' WHERE project_id=$1`,
    [opts.project_id],
  );
  await expect(resendPeopleInviteLocal(opts)).rejects.toThrow("another bay");
  const deleted = await fixture();
  await getPool().query(
    `UPDATE projects SET deleted=true WHERE project_id=$1`,
    [deleted.project_id],
  );
  await expect(resendPeopleInviteLocal(deleted)).rejects.toThrow(
    "project not found",
  );
  expect(send_invite_email).not.toHaveBeenCalled();
});
