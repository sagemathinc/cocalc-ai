/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import {
  addOutreachRecipient,
  createOutreachBatch,
  getOutreachBatch,
  transitionOutreachBatch,
  updateOutreachRecipient,
} from "./store";

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({
    crm_outreach_company_postal_address: "Test postal address",
    crm_outreach_zendesk_webhook_secret: "test-only-outreach-secret",
  }),
}));
jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: async () => "https://example.test",
}));

beforeAll(async () => await before({ noConat: true }), 15000);
afterAll(after);

async function draft() {
  const account_id = randomUUID();
  const organization = randomUUID();
  const person = randomUUID();
  const emailId = randomUUID();
  const common = { account_id, reason: "Review draft edit behavior" };
  await getPool().query(
    `INSERT INTO crm_organizations
      (id,customer_number,display_name,organization_type,lifecycle_stage,created_by_account_id,updated_by_account_id)
      VALUES($1::uuid,$1::text,'Example University','university','prospect',$2,$2)`,
    [organization, account_id],
  );
  await getPool().query(
    `INSERT INTO crm_people (id,display_name,created_by_account_id,updated_by_account_id)
      VALUES($1,'Ada Prospect',$2,$2)`,
    [person, account_id],
  );
  await getPool().query(
    `INSERT INTO crm_person_emails (id,person_id,email_address,normalized_email,verified,is_primary)
      VALUES($1,$2,$3,$3,true,true)`,
    [emailId, person, `${person}@example.test`],
  );
  await getPool().query(
    `INSERT INTO crm_organization_people (id,organization_id,person_id)
      VALUES($1,$2,$3)`,
    [randomUUID(), organization, person],
  );
  const created = await createOutreachBatch({
    ...common,
    name: "Edit regression batch",
    purpose: "Test reviewed content",
    kind: "adoption_pilot",
    owner_account_id: account_id,
    commit: true,
    expected_version: 0,
    idempotency_key: randomUUID(),
  });
  if (created.preview) throw Error("expected committed batch");
  const batch = created.result.id;
  const added = await addOutreachRecipient({
    ...common,
    batch,
    organization,
    person,
    subject: "Original subject",
    body_markdown: "Original body",
    commit: true,
    expected_version: 1,
    idempotency_key: randomUUID(),
  });
  if (added.preview) throw Error("expected committed recipient");
  const original = added.result;
  const edit = {
    ...common,
    batch,
    delivery: original.id,
    subject: "Updated subject",
    body_markdown: "Updated **body**",
  };
  return { common, batch, original, edit };
}

it("previews without writes, preserves identity/footer, and invalidates stale approval", async () => {
  const { common, batch, original, edit } = await draft();
  const preview = await updateOutreachRecipient(edit);
  expect(preview).toMatchObject({ preview: true, expected_version: 2 });
  if (!preview.preview) throw Error("expected preview");
  expect((await getOutreachBatch({ ...common, batch })).deliveries[0]).toEqual(
    original,
  );
  const committed = await updateOutreachRecipient({
    ...edit,
    commit: true,
    expected_version: preview.expected_version,
    idempotency_key: preview.idempotency_key,
  });
  if (committed.preview) throw Error("expected committed edit");
  expect(committed.result).toMatchObject({
    id: original.id,
    subject: edit.subject,
    body_markdown: `${edit.body_markdown}\n\n${original.footer}`,
    normalized_email: original.normalized_email,
    template_snapshot: original.template_snapshot,
    footer: original.footer,
    opt_out_token_digest: original.opt_out_token_digest,
    follow_up_policy: original.follow_up_policy,
    version: original.version + 1,
  });
  expect((await getOutreachBatch({ ...common, batch })).batch.version).toBe(3);
  await expect(
    transitionOutreachBatch({
      ...common,
      batch,
      action: "approve",
      commit: true,
      expected_version: 2,
      idempotency_key: randomUUID(),
    }),
  ).rejects.toThrow("expected version 2, current version is 3");
});

it.each(["approved", "cancelled"])(
  "replays an edit after state changes to %s without reapplying it",
  async (state) => {
    const { batch, edit } = await draft();
    const request = {
      ...edit,
      commit: true,
      expected_version: 2,
      idempotency_key: randomUUID(),
    };
    const committed = await updateOutreachRecipient(request);
    if (committed.preview) throw Error("expected committed edit");
    await getPool().query(
      "UPDATE crm_outreach_batches SET state=$1,version=version+1 WHERE id=$2",
      [state, batch],
    );
    await getPool().query(
      "UPDATE crm_outreach_deliveries SET state=$1,version=version+1 WHERE id=$2",
      [state, edit.delivery],
    );
    expect(await updateOutreachRecipient(request)).toMatchObject({
      replayed: true,
      result: committed.result,
    });
    await expect(
      updateOutreachRecipient({ ...request, subject: "Different payload" }),
    ).rejects.toThrow("idempotency key was already used");
    await expect(
      updateOutreachRecipient({
        ...request,
        expected_version: 4,
        idempotency_key: randomUUID(),
      }),
    ).rejects.toThrow("only draft recipients can be edited");
    await expect(updateOutreachRecipient(edit)).rejects.toThrow(
      "only draft recipients can be edited",
    );
  },
);

it("writes a revision that restores earlier text instead of replaying it", async () => {
  const { common, batch, original, edit } = await draft();
  async function revise(body_markdown: string) {
    const request = { ...edit, body_markdown };
    const preview = await updateOutreachRecipient(request);
    if (!preview.preview) throw Error("expected preview");
    const committed = await updateOutreachRecipient({
      ...request,
      commit: true,
      expected_version: preview.expected_version,
      idempotency_key: preview.idempotency_key,
    });
    if (committed.preview) throw Error("expected committed edit");
    expect(committed.replayed).toBe(false);
  }
  await revise("Body B");
  await revise("Body A");
  await revise("Body B");
  expect(
    (await getOutreachBatch({ ...common, batch })).deliveries[0].body_markdown,
  ).toBe(`Body B\n\n${original.footer}`);
});

it("does not append a second footer to a body copied with its footer", async () => {
  const { common, batch, original, edit } = await draft();
  const copied = original.body_markdown.replace(
    "Original body",
    "Corrected body",
  );
  const request = { ...edit, body_markdown: `${copied}\n` };
  const preview = await updateOutreachRecipient(request);
  if (!preview.preview) throw Error("expected preview");
  await updateOutreachRecipient({
    ...request,
    commit: true,
    expected_version: preview.expected_version,
    idempotency_key: preview.idempotency_key,
  });
  const stored = (await getOutreachBatch({ ...common, batch })).deliveries[0];
  expect(stored.body_markdown).toBe(`Corrected body\n\n${original.footer}`);
  expect(stored.body_markdown.split("/crm/outreach/opt-out/")).toHaveLength(2);
});
