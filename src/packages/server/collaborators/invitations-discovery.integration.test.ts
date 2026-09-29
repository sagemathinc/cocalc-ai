/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  ensureProjectCollabInviteEmailTokenSchema,
  hashInviteEmail,
} from "@cocalc/server/projects/collaborators";
import { inspectInvitationProject } from "./invitations-discovery";
import type { PeopleInvitationRecipient } from "@cocalc/util/people-invitations";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  getSecretSettingsKey: async () => Buffer.alloc(32, 7),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ collaborators_enabled: true }),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: async () => ({
    bay_id: "discovery-test",
    epoch: 1,
  }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "discovery-test",
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  searchClusterAccounts: jest.fn(),
}));
jest.mock("@cocalc/server/accounts/usernames", () => ({
  resolveUsernameOwner: jest.fn(),
}));
jest.mock("@cocalc/server/people/api", () => ({}));
jest.mock("@cocalc/server/people/common", () => ({}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("invitation discovery against the real invitation schema", () => {
  let account_id: string;
  let recipient_id: string;
  let project_id: string;
  const email = "recipient@example.test";
  const policy = { mode: "selected", paths: ["notes"] };

  beforeAll(async () => {
    await initEphemeralDatabase();
    await ensureProjectCollabInviteEmailTokenSchema();
  }, 60000);
  afterAll(async () => {
    await getPool().end();
  });
  beforeEach(async () => {
    account_id = randomUUID();
    recipient_id = randomUUID();
    project_id = randomUUID();
    await getPool().query("INSERT INTO accounts(account_id) VALUES($1),($2)", [
      account_id,
      recipient_id,
    ]);
    await getPool().query(
      `INSERT INTO projects(project_id,title,users,owning_bay_id)
       VALUES($1,'Discovery project',$2::jsonb,'discovery-test')`,
      [project_id, JSON.stringify({ [account_id]: { group: "owner" } })],
    );
  });

  async function offer({
    source = "account",
    age = 1,
    sender = account_id,
    scope = "project_collab",
    status = "pending",
  }: {
    source?: string | null;
    age?: number;
    sender?: string;
    scope?: string | null;
    status?: string;
  } = {}) {
    await getPool().query(
      `INSERT INTO project_collab_invites
       (invite_id,project_id,inviter_account_id,invitee_account_id,email_hash,
        invite_source,scope,status,invite_role,read_policy,created)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'viewer',$9::jsonb,
         now()-$10::integer*interval '1 day')`,
      [
        randomUUID(),
        project_id,
        sender,
        recipient_id,
        await hashInviteEmail(email),
        source,
        scope,
        status,
        JSON.stringify(policy),
        age,
      ],
    );
  }
  function inspect(
    recipient: PeopleInvitationRecipient = {
      kind: "account",
      account_id: recipient_id,
    },
  ) {
    return inspectInvitationProject({
      account_id,
      project_id,
      recipient,
      route: { bay_id: "discovery-test", epoch: 1 },
    });
  }

  it("queries the actual table with no stored expires column", async () => {
    const columns = await getPool().query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='project_collab_invites' AND column_name='expires'`,
    );
    expect(columns.rows).toHaveLength(0);
    expect(await inspect()).toMatchObject({
      title: "Discovery project",
      can_invite: true,
      current_access: "none",
    });
  });

  it.each([
    [null, 29, true],
    [null, 31, false],
    ["account", 29, true],
    ["account", 31, false],
    ["email", 13, true],
    ["email", 15, false],
    ["course_email", 13, true],
    ["course_email", 15, false],
  ])(
    "applies source %s expiry to a %s-day-old offer",
    async (source, age, live) => {
      await offer({ source, age });
      const result = await inspect(
        source === "email" || source === "course_email"
          ? { kind: "email", email_address: email }
          : { kind: "account", account_id: recipient_id },
      );
      expect(result?.pending).toEqual(
        live ? { role: "viewer", read_policy: policy } : undefined,
      );
      expect(result?.can_invite).toBe(true);
    },
  );

  it("ignores other senders, scopes and nonpending rows but accepts legacy null scope", async () => {
    await offer({ sender: recipient_id });
    await offer({ scope: "course_student" });
    await offer({ status: "accepted" });
    expect((await inspect())?.pending).toBeUndefined();
    await offer({ scope: null });
    expect((await inspect())?.pending).toEqual({
      role: "viewer",
      read_policy: policy,
    });
    expect((await inspect())?.can_invite).toBe(true);
  });

  it("does not mistake an expired duplicate for conflicting pending offers", async () => {
    await offer({ age: 31 });
    await offer();
    expect((await inspect())?.can_invite).toBe(true);
    await offer();
    expect(await inspect()).toMatchObject({
      can_invite: false,
      unavailable_reason: expect.stringContaining("Multiple pending offers"),
    });
  });
});
