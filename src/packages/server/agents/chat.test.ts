import { randomUUID } from "node:crypto";

const acquire = jest.fn();
const release = jest.fn();

jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: (...args: any[]) => acquire(...args),
  releaseChatSyncDB: (...args: any[]) => release(...args),
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  conatWithProjectRoutingForAccount: jest.fn(() => ({ client: true })),
}));

import { agentChatMetadataPath, withAgentChat } from "./chat";

test("agent chat validation opens and releases the hidden metadata document", async () => {
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

  await expect(
    withAgentChat(
      { project_id, path, thread_id, created_by: randomUUID() },
      async (_db, selected) => selected,
    ),
  ).resolves.toBe(thread);

  const metadataPath = agentChatMetadataPath(path);
  expect(metadataPath).toBe(
    "/home/user/.local/share/cocalc/agents/.example.chat.chat",
  );
  expect(acquire).toHaveBeenCalledWith(
    expect.objectContaining({ project_id, path: metadataPath }),
  );
  expect(release).toHaveBeenCalledWith(project_id, metadataPath);
});
