import { randomUUID } from "node:crypto";
import { updateCollaborationPersonalState } from "./personal";
import type { CollaborationResource } from "@cocalc/util/collaborators";

const name = jest.fn();
const retire = jest.fn();
const identity = jest.fn();
const libraryName = jest.fn();
const libraryPin = jest.fn();
const generic = jest.fn();
const legacy = jest.fn();
const libraryClear = jest.fn();
const clearFallback = jest.fn();
const reconcileAgent = jest.fn();
jest.mock("@cocalc/database/postgres/collaborators-agent-personal", () => ({
  ...jest.requireActual(
    "@cocalc/database/postgres/collaborators-agent-personal",
  ),
  reconcileCollaborationAgentPersonalState: (...args) =>
    reconcileAgent(...args),
}));
jest.mock("@cocalc/server/agents/personal", () => ({
  nameAgent: (...a) => name(...a),
  retireNamedAgent: (...a) => retire(...a),
}));
jest.mock("@cocalc/server/agents/api", () => ({
  getIdentity: (...a) => identity(...a),
}));
jest.mock("@cocalc/server/agents/personal-rehome", () => ({
  assertPersonalAccountAuthority: jest.fn(),
}));
jest.mock("@cocalc/server/artifacts/personal-library-api", () => ({
  personalLibraryApi: {
    name: (...a) => libraryName(...a),
    setPinned: (...a) => libraryPin(...a),
  },
}));
jest.mock("@cocalc/server/artifacts/personal-library-store", () => ({
  clearPersonalLibraryAlias: (...a) => libraryClear(...a),
}));
jest.mock("@cocalc/database/postgres/collaborators-discovery", () => ({
  getCollaborationPersonalState: async () => ({}),
  setCollaborationPersonalState: (...a) => generic(...a),
}));
jest.mock("@cocalc/database/postgres/collaborators-personal", () => ({
  ...jest.requireActual("@cocalc/database/postgres/collaborators-personal"),
  legacyCollaborationPersonalState: (...a) => legacy(...a),
  clearCollaborationAgentFallback: (...a) => clearFallback(...a),
}));
const account_id = randomUUID();
const resource: CollaborationResource = {
  project_id: randomUUID(),
  kind: "agent",
  resource_id: "agent-thread:thread",
  chat_path: "/home/user/a.chat",
  thread_id: "thread",
  title: "Agent",
  participant_ids: [],
  created_at: 1,
  updated_at: 2,
  activity: 2,
};
beforeEach(() => {
  jest.clearAllMocks();
  identity.mockResolvedValue({
    path: resource.chat_path,
    thread_id: resource.thread_id,
  });
});
test("unnamed sessions retain a thread-local name and shortcut without agent enrollment", async () => {
  await updateCollaborationPersonalState(account_id, resource, {
    alias: "alice",
    collected: true,
  });
  expect(name).not.toHaveBeenCalled();
  expect(generic).toHaveBeenCalledWith(
    account_id,
    resource,
    { alias: "alice", collected: true },
    resource,
  );
  expect(identity).not.toHaveBeenCalled();
});

test("owner-verified legacy catalog keys stay authoritative for attention until canonical publication", async () => {
  const agent_id = randomUUID();
  const legacy = {
    ...resource,
    agent_id,
    resource_id: agent_id,
    agent_catalog_resource_id: resource.resource_id,
  };
  await updateCollaborationPersonalState(account_id, legacy, {
    following: true,
  });
  expect(generic).toHaveBeenCalledWith(
    account_id,
    { ...legacy, resource_id: resource.resource_id },
    { following: true },
    { ...legacy, resource_id: resource.resource_id },
  );
  expect(name).not.toHaveBeenCalled();
  expect(identity).not.toHaveBeenCalled();
});
test("known endpoint naming and removal use the existing namespace without touching attention choices", async () => {
  const known = { ...resource, agent_id: randomUUID() };
  const canonical = { ...known, resource_id: known.agent_id };
  await updateCollaborationPersonalState(account_id, known, {
    alias: "alice",
    following: true,
  });
  expect(name).toHaveBeenCalledWith({
    account_id,
    endpoint: { project_id: known.project_id, agent_id: known.agent_id },
    name: "alice",
    thread_title: known.title,
  });
  expect(generic).toHaveBeenCalledWith(
    account_id,
    canonical,
    { following: true },
    canonical,
  );
  expect(clearFallback).toHaveBeenCalledWith(account_id, canonical, {
    alias: true,
    collected: false,
  });
  await updateCollaborationPersonalState(account_id, known, { alias: "" });
  expect(retire).toHaveBeenCalledWith({
    account_id,
    endpoint: { project_id: known.project_id, agent_id: known.agent_id },
  });
});

test("legacy point-target writes reconcile personal state before using the canonical agent key", async () => {
  const known = {
    ...resource,
    agent_id: randomUUID(),
    agent_resource_ids: [resource.resource_id],
  };
  await updateCollaborationPersonalState(account_id, known, {
    following: false,
  });
  expect(reconcileAgent).toHaveBeenCalledWith(account_id, [known]);
  expect(generic).toHaveBeenCalledWith(
    account_id,
    { ...known, resource_id: known.agent_id },
    { following: false },
    { ...known, resource_id: known.agent_id },
  );
  expect(name).not.toHaveBeenCalled();
  expect(identity).not.toHaveBeenCalled();
});
test("moved or mismatched identities fail before mutation", async () => {
  identity.mockResolvedValue({
    path: "/home/user/different.chat",
    thread_id: "thread",
  });
  await expect(
    updateCollaborationPersonalState(
      account_id,
      { ...resource, agent_id: randomUUID() },
      { alias: "alice" },
    ),
  ).rejects.toThrow("no longer matches");
  expect(name).not.toHaveBeenCalled();
  expect(generic).not.toHaveBeenCalled();
});
test("artifact aliases, removal and collection use Library", async () => {
  const artifact = {
    ...resource,
    kind: "artifact" as const,
    entry_id: "a".repeat(64),
    artifact_id: "artifact",
  };
  await updateCollaborationPersonalState(account_id, artifact, {
    alias: "notes",
    collected: true,
  });
  expect(libraryName).toHaveBeenCalledWith({
    account_id,
    project_id: artifact.project_id,
    entry_id: artifact.entry_id,
    name: "notes",
  });
  expect(libraryPin).toHaveBeenCalledWith({
    account_id,
    pin_key: JSON.stringify([
      artifact.project_id,
      artifact.chat_path,
      artifact.thread_id,
      artifact.artifact_id,
    ]),
    pinned: true,
  });
  expect(generic).toHaveBeenCalledWith(account_id, artifact, {}, artifact);
  await updateCollaborationPersonalState(account_id, artifact, { alias: "" });
  expect(libraryClear).toHaveBeenCalledWith({
    account_id,
    project_id: artifact.project_id,
    entry_id: artifact.entry_id,
  });
});
test("invalid attention patches fail before any legacy namespace write", async () => {
  await expect(
    updateCollaborationPersonalState(
      account_id,
      { ...resource, agent_id: randomUUID() },
      { alias: "alice", read_through: 100 },
    ),
  ).rejects.toThrow("exceeds");
  expect(name).not.toHaveBeenCalled();
  expect(generic).not.toHaveBeenCalled();
});
