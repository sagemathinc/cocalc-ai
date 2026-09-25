import { randomUUID } from "node:crypto";

const acquire = jest.fn();
const release = jest.fn();
const getTrustedClient = jest.fn();
const assertActor = jest.fn();
let workspaceRuntime = false;

jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: (...args: any[]) => acquire(...args),
  releaseChatSyncDB: (...args: any[]) => release(...args),
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  conatWithProjectRoutingForAccount: jest.fn(() => ({ client: true })),
}));
jest.mock("@cocalc/server/conat/file-server-client", () => ({
  getTrustedProjectHostClient: (...args: any[]) => getTrustedClient(...args),
}));
jest.mock("./access", () => ({
  assertActor: (...args: any[]) => assertActor(...args),
}));
jest.mock("@cocalc/server/launchpad/project-runtime", () => ({
  isWorkspaceProjectRuntime: () => workspaceRuntime,
}));

import { withAgentChat } from "./chat";

beforeEach(() => {
  workspaceRuntime = false;
  acquire.mockReset();
  release.mockReset();
  getTrustedClient.mockReset();
  assertActor.mockReset();
});

test("agent chat validation opens and releases the registered chat document", async () => {
  const project_id = randomUUID();
  const thread_id = randomUUID();
  const path = "/home/user/.local/share/cocalc/agents/example.chat";
  const thread = {
    event: "chat-thread-config",
    thread_id,
    agent_kind: "acp",
    archived: false,
  };
  acquire.mockResolvedValue({ get: () => [thread] });
  getTrustedClient.mockResolvedValue({ client: true });
  assertActor.mockResolvedValue(undefined);
  const account_id = randomUUID();

  await expect(
    withAgentChat(
      { project_id, path, thread_id, created_by: account_id },
      async (_db, selected) => selected,
    ),
  ).resolves.toBe(thread);

  expect(acquire).toHaveBeenCalledWith(
    expect.objectContaining({ project_id, path }),
  );
  expect(assertActor).toHaveBeenCalledWith(account_id, project_id);
  expect(getTrustedClient).toHaveBeenCalledWith({
    project_id,
    account_id,
  });
  expect(release).toHaveBeenCalledWith(project_id, path);
});

test("agent chat validation does not open a host connection without project access", async () => {
  workspaceRuntime = false;
  assertActor.mockRejectedValueOnce(new Error("not a collaborator"));
  await expect(
    withAgentChat(
      {
        project_id: randomUUID(),
        path: "/home/user/agent.chat",
        thread_id: randomUUID(),
        created_by: randomUUID(),
      },
      async () => undefined,
    ),
  ).rejects.toThrow("not a collaborator");
  expect(getTrustedClient).not.toHaveBeenCalled();
});

test("workspace runtime keeps its local project connection", async () => {
  workspaceRuntime = true;
  assertActor.mockResolvedValue(undefined);
  const thread_id = randomUUID();
  acquire.mockResolvedValue({
    get: () => [{ event: "chat-thread-config", thread_id, agent_kind: "acp" }],
  });
  await withAgentChat(
    {
      project_id: randomUUID(),
      path: "/home/user/agent.chat",
      thread_id,
      created_by: randomUUID(),
    },
    async () => undefined,
  );
  expect(getTrustedClient).not.toHaveBeenCalled();
});
