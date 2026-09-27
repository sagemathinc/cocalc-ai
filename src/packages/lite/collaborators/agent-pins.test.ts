/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  closeDatabase,
  getRow,
  initDatabase,
  upsertRow,
} from "../hub/sqlite/database";
import { liteAgentPins } from "./agent-pins";
import { LiteCollaborators } from "./index";
import type { CollaborationResource } from "@cocalc/util/collaborators";

const account_id = "human";
const project_id = "11111111-1111-4111-8111-111111111111";
const agent_id = "22222222-2222-4222-8222-222222222222";
const pk = JSON.stringify({ account_id });
const setting = "experimental_my_agents_organization_v1";
const resource: CollaborationResource = {
  project_id,
  kind: "agent",
  resource_id: "agent-thread:thread",
  agent_id,
  chat_path: "/home/user/agent.chat",
  thread_id: "thread",
  title: "Agent",
  participant_ids: [],
  created_at: 1,
  updated_at: 2,
  activity: 3,
};
let store: LiteCollaborators;

beforeEach(async () => {
  initDatabase({ filename: ":memory:" });
  upsertRow("accounts", pk, {
    account_id,
    other_settings: { keep: 7, [setting]: { pinned: "[]", folders: "kept" } },
  });
  store = new LiteCollaborators({
    filename: ":memory:",
    account_id,
    project_id,
    isEnabled: () => true,
    agentPins: liteAgentPins(account_id),
  });
  const { epoch } = await store.registerSource({
    project_id,
    chat_path: resource.chat_path,
    expected_epoch: null,
    registration_id: "writer",
  });
  await store.ingest({
    snapshot: {
      project_id,
      chat_path: resource.chat_path,
      epoch,
      sequence: 1,
      resources: [
        resource,
        {
          ...resource,
          agent_id: undefined,
          resource_id: "unnamed",
          thread_id: "unnamed",
        },
      ],
    },
  });
});
afterEach(() => {
  store.close();
  closeDatabase();
});

test("collection uses the existing account preference, preserves other settings, and never retires an agent", async () => {
  await store.api.setPersonalState({
    ...resource,
    account_id,
    patch: { alias: "helper", collected: true, following: true },
  });
  const row = getRow("accounts", pk);
  expect(row.other_settings).toEqual({
    keep: 7,
    [setting]: { folders: "kept", pinned: JSON.stringify([agent_id]) },
  });
  expect(
    (await store.api.listResources({ account_id, scope: "collected" })).items,
  ).toHaveLength(1);
  await store.api.setPersonalState({
    ...resource,
    account_id,
    patch: { collected: false },
  });
  expect(
    (await store.api.getResource({ ...resource, account_id }))?.personal,
  ).toMatchObject({ alias: "helper", following: true, collected: false });
  expect(liteAgentPins(account_id).read()).toEqual([]);
});

test("an external Agents pin change is reflected without manufacturing identities for unnamed sources", async () => {
  liteAgentPins(account_id).set(agent_id, true);
  expect(
    (
      await store.api.listResources({ account_id, scope: "collected" })
    ).items.map((item) => item.resource_id),
  ).toEqual([resource.resource_id]);
  await store.api.setPersonalState({
    ...resource,
    account_id,
    resource_id: "unnamed",
    patch: { collected: true },
  });
  expect(liteAgentPins(account_id).read()).toEqual([agent_id]);
  expect(
    (
      await store.api.listResources({ account_id, scope: "collected" })
    ).items.map((item) => item.resource_id),
  ).toEqual([resource.resource_id, "unnamed"]);
  liteAgentPins(account_id).set(agent_id, false);
  expect(
    (
      await store.api.listResources({ account_id, scope: "collected" })
    ).items.map((item) => item.resource_id),
  ).toEqual(["unnamed"]);
  await store.api.setPersonalState({
    ...resource,
    account_id,
    resource_id: "unnamed",
    patch: { collected: false },
  });
  expect(
    (await store.api.listResources({ account_id, scope: "collected" })).items,
  ).toEqual([]);
});

test("alias conflict does not partially write the existing Agents pin preference", async () => {
  await store.api.setPersonalState({
    ...resource,
    account_id,
    resource_id: "unnamed",
    patch: { alias: "taken" },
  });
  await expect(
    store.api.setPersonalState({
      ...resource,
      account_id,
      patch: { alias: "taken", collected: true },
    }),
  ).rejects.toThrow("alias already used");
  expect(liteAgentPins(account_id).read()).toEqual([]);
});

test("unnamed agents use stable generic aliases and collection without enrollment or pin side effects", async () => {
  const target = { ...resource, account_id, resource_id: "unnamed" };
  await store.api.setPersonalState({
    ...target,
    patch: {
      alias: "@Research",
      collected: true,
      following: true,
      muted: true,
      read_through: 2,
    },
  });
  expect((await store.api.getResource(target))?.personal).toEqual({
    alias: "research",
    collected: true,
    following: true,
    muted: true,
    read_through: 2,
  });
  expect(liteAgentPins(account_id).read()).toEqual([]);
  await store.api.setPersonalState({ ...target, patch: { alias: "" } });
  expect((await store.api.getResource(target))?.personal).toEqual({
    collected: true,
    following: true,
    muted: true,
    read_through: 2,
  });
  expect((await store.api.getResource(target))?.resource_id).toBe("unnamed");
  expect((await store.api.getResource(target))?.agent_id).toBeUndefined();
});
