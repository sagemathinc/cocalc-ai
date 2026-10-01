/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
jest.mock("@cocalc/database/settings/secret-settings", () => ({
  getSecretSettingsKey: async () => Buffer.alloc(32, 7),
}));
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { assertNoPeopleProjectStateForRehome } from "./rehome";
import type { PeopleAccessInput } from "@cocalc/conat/inter-bay/people-actions";
import {
  claimPeopleAction,
  finishPeopleAction,
  readPeopleAction,
  recoverPeopleAction,
  peopleActionBinding,
} from "./invitation-action-store";

beforeAll(async () => {
  await initEphemeralDatabase();
}, 30000);
afterAll(async () => {
  await getPool().end();
});
async function fixture(): Promise<PeopleAccessInput> {
  const project_id = randomUUID();
  await getPool().query(
    "INSERT INTO projects(project_id,owning_bay_id) VALUES($1,'bay-0')",
    [project_id],
  );
  const action = {
    project_id,
    action: "offer_access" as const,
    role: "collaborator" as const,
  };
  return {
    account_id: randomUUID(),
    child_operation_id: randomUUID(),
    action,
    payload: {
      recipient: { kind: "email", email_address: "private@example.invalid" },
      projects: [action],
      message: "private authored message",
      channels: { notification: false, email: true },
    },
  };
}
it("claims durably once and binds the full private payload without plaintext storage", async () => {
  const input = await fixture();
  const binding = await peopleActionBinding(input);
  expect(await readPeopleAction(input, binding)).toBeUndefined();
  expect(await claimPeopleAction(input, binding, async () => {})).toBe(true);
  expect(await claimPeopleAction(input, binding, async () => {})).toBe(false);
  expect(await readPeopleAction(input, binding)).toMatchObject({
    status: "unknown",
  });
  const row = (
    await getPool().query(
      "SELECT * FROM people_invitation_action_receipts WHERE child_operation_id=$1",
      [input.child_operation_id],
    )
  ).rows[0];
  expect(JSON.stringify(row)).not.toContain("private@");
  expect(JSON.stringify(row)).not.toContain("private authored");
  const changed = {
    ...input,
    payload: { ...input.payload, message: "substituted" },
  };
  await expect(
    readPeopleAction(changed, await peopleActionBinding(changed)),
  ).rejects.toThrow("payload mismatch");
  const receipt = {
    ...(await readPeopleAction(input, binding))!,
    status: "created" as const,
    access_invite_id: randomUUID(),
  };
  await finishPeopleAction(input, binding, receipt);
  expect(await readPeopleAction(input, binding)).toEqual(receipt);
  expect(
    await recoverPeopleAction(
      input,
      binding,
      { ...receipt, delivery: [{ channel: "email", status: "unknown" }] },
      getPool(),
    ),
  ).toEqual(receipt);
});
it("persists recovered access evidence without retrying the inline send", async () => {
  const input = await fixture();
  const binding = await peopleActionBinding(input);
  await claimPeopleAction(input, binding, async () => {});
  const recovered = {
    ...(await readPeopleAction(input, binding))!,
    status: "created" as const,
    access_invite_id: input.child_operation_id,
    delivery: [{ channel: "email" as const, status: "unknown" as const }],
  };
  expect(
    await recoverPeopleAction(input, binding, recovered, getPool()),
  ).toEqual(recovered);
  expect(await readPeopleAction(input, binding)).toEqual(recovered);
});
it("rolls back admission when the owner fence rejects", async () => {
  const input = await fixture();
  const binding = await peopleActionBinding(input);
  await expect(
    claimPeopleAction(input, binding, async () => {
      throw Error("stale owner");
    }),
  ).rejects.toThrow("stale owner");
  expect(await readPeopleAction(input, binding)).toBeUndefined();
});
it("cascades owner receipts on project hard deletion", async () => {
  const input = await fixture();
  const binding = await peopleActionBinding(input);
  await claimPeopleAction(input, binding, async () => {});
  await getPool().query("DELETE FROM projects WHERE project_id=$1", [
    input.action.project_id,
  ]);
  expect(await readPeopleAction(input, binding)).toBeUndefined();
});
it("concurrent admissions have one durable winner and block unsupported rehome", async () => {
  const input = await fixture();
  const binding = await peopleActionBinding(input);
  const claims = await Promise.all([
    claimPeopleAction(input, binding, async () => {}),
    claimPeopleAction(input, binding, async () => {}),
  ]);
  expect(claims.sort()).toEqual([false, true]);
  await expect(
    assertNoPeopleProjectStateForRehome(getPool(), input.action.project_id),
  ).rejects.toThrow("receipt state exists");
});
