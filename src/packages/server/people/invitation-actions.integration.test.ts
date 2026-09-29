/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import type { PeopleExecuteInput } from "@cocalc/conat/inter-bay/people-actions";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  getSecretSettingsKey: async () => Buffer.alloc(32, 7),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ collaborators_enabled: true }),
}));
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-owner",
  () => ({ getOwnedCollaborationResource: jest.fn() }),
);
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "people-owner",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({ home_bay_id: "people-owner" }),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: async () => ({ bay_id: "people-owner", epoch: 0 }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: async (account_id) => ({
    account_id,
    home_bay_id: "people-recipient",
    banned: false,
  }),
}));
jest.mock("@cocalc/server/accounts/trusted-product-access", () => ({
  assertAccountTrustedForProductAccess: jest.fn(),
}));
jest.mock("@cocalc/server/membership/project-limits", () => ({
  assertProjectCollaboratorInviteLimit: jest.fn(),
}));
// Keep the actual preflight and receipt SQL. Legacy mutation/transport behavior
// has separate coverage; no synthetic expires column may mask a bad query here.
jest.mock("@cocalc/server/projects/collaborators", () => ({
  assertCanManageProjectCollaborators: jest.fn(),
  assertEmailInviteBatchLimit: jest.fn(),
  assertEmailInviteCreationLimits: jest.fn(),
  ensureProjectCollabInviteEmailTokenSchema: jest.fn(),
  hashInviteEmail: async (s) => `hash:${s}`,
  normalizeInviteMessageForAccount: jest.fn(),
  createCollabInvite: jest.fn(),
  inviteCollaboratorWithoutAccount: jest.fn(),
}));

import {
  preflightPeopleInvitationAction,
  executePeopleInvitationAccess,
} from "./invitation-actions";
import {
  createCollabInvite,
  inviteCollaboratorWithoutAccount,
} from "@cocalc/server/projects/collaborators";

beforeAll(async () => {
  await initEphemeralDatabase();
  await getPool().query(`ALTER TABLE project_collab_invites
    ADD COLUMN IF NOT EXISTS invite_source TEXT,
    ADD COLUMN IF NOT EXISTS invite_role TEXT,
    ADD COLUMN IF NOT EXISTS read_policy JSONB,
    ADD COLUMN IF NOT EXISTS email_hash TEXT,
    ADD COLUMN IF NOT EXISTS scope TEXT,
    ADD COLUMN IF NOT EXISTS context JSONB`);
  expect(
    (
      await getPool().query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='project_collab_invites' AND column_name='expires'`)
    ).rows,
  ).toEqual([]);
}, 30000);
afterAll(async () => {
  await getPool().end();
});
beforeEach(() => {
  jest.clearAllMocks();
});
async function fixture(email = false): Promise<PeopleExecuteInput> {
  const account_id = randomUUID();
  const recipient = randomUUID();
  const project_id = randomUUID();
  await getPool().query(
    "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,'people-owner'),($2,'people-recipient')",
    [account_id, recipient],
  );
  await getPool().query(
    "INSERT INTO projects(project_id,owning_bay_id,users) VALUES($1,'people-owner',$2::jsonb)",
    [project_id, JSON.stringify({ [account_id]: { group: "owner" } })],
  );
  const action = {
    project_id,
    action: "offer_access" as const,
    role: "collaborator" as const,
  };
  return {
    account_id,
    child_operation_id: randomUUID(),
    action,
    authorization_expires_at: Date.now() + 60000,
    payload: {
      recipient: email
        ? { kind: "email", email_address: "recipient@example.invalid" }
        : { kind: "account", account_id: recipient },
      projects: [action],
      message: "Please join",
      channels: { notification: true, email: true },
    },
  };
}
async function insert(input: PeopleExecuteInput, age: number, source?: string) {
  const invite_id = randomUUID();
  const recipient = input.payload.recipient;
  const email = recipient.kind === "email";
  await getPool().query(
    `INSERT INTO project_collab_invites
    (invite_id,project_id,inviter_account_id,invitee_account_id,invite_source,invite_role,status,message,email_hash,scope,context,created,updated)
    VALUES($1,$2,$3,$4,$5,'collaborator','pending',$6,$7,$8,$9::jsonb,now()-($10::int * interval '1 day'),now())`,
    [
      invite_id,
      input.action.project_id,
      input.account_id,
      email ? null : recipient.account_id,
      source ?? (email ? "email" : "account"),
      input.payload.message,
      email ? `hash:${recipient.email_address}` : null,
      email ? "project_collab" : null,
      email ? JSON.stringify({ require_invite_email_match: false }) : null,
      age,
    ],
  );
  return invite_id;
}
it("runs actual empty pending-offer preflight SQL without a physical expires column", async () => {
  const i = await fixture();
  expect(
    await preflightPeopleInvitationAction(i.account_id, i.payload, i.action),
  ).toMatchObject({ recipient_access: "insufficient", warnings: [] });
});
it("email preflight leaves identity/access unknown while checking real pending-owner rows", async () => {
  const i = await fixture(true);
  expect(
    await preflightPeopleInvitationAction(i.account_id, i.payload, i.action),
  ).toMatchObject({ recipient_access: "unknown", warnings: [] });
});
it.each([false, true])(
  "reuses an unexpired owner offer using computed expiry (email=%s)",
  async (email) => {
    const i = await fixture(email);
    const invite_id = await insert(i, 1);
    expect(
      await preflightPeopleInvitationAction(i.account_id, i.payload, i.action),
    ).toMatchObject({ warnings: ["compatible_pending_offer"] });
    expect(await executePeopleInvitationAccess(i)).toMatchObject({
      status: "reused",
      access_invite_id: invite_id,
    });
    expect(createCollabInvite).not.toHaveBeenCalled();
    expect(inviteCollaboratorWithoutAccount).not.toHaveBeenCalled();
  },
);
it.each([
  [false, 29, true],
  [false, 31, false],
  [true, 13, true],
  [true, 15, false],
] as const)(
  "matches legacy expiry windows (email=%s days=%s pending=%s)",
  async (email, days, isPending) => {
    const i = await fixture(email);
    await insert(i, days);
    expect(
      (await preflightPeopleInvitationAction(i.account_id, i.payload, i.action))
        .warnings,
    ).toEqual(isPending ? ["compatible_pending_offer"] : []);
  },
);
it("expired course-email rows use the email TTL without becoming an ordinary offer", async () => {
  const i = await fixture(true);
  await insert(i, 15, "course_email");
  expect(
    (await preflightPeopleInvitationAction(i.account_id, i.payload, i.action))
      .warnings,
  ).toEqual([]);
});
it("the legacy beforeReuse race hook also reads a computed expiry", async () => {
  const i = await fixture();
  jest
    .mocked(createCollabInvite)
    .mockImplementation(async (_opts, internal) => {
      const invite_id = await insert(i, 1);
      await internal?.beforeReuse?.(invite_id);
      return { created: false, invite: { invite_id } as any };
    });
  expect(await executePeopleInvitationAccess(i)).toMatchObject({
    status: "reused",
  });
});
