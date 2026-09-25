import { createNamedAgent, type PendingAgentCreation } from "./create";
import { fsClient } from "@cocalc/conat/files/fs";

const pending: PendingAgentCreation = {
  projectId: "project-id",
  path: "/home/user/.local/share/cocalc/agents/agent.chat",
  threadId: "thread-id",
};

function fixtures() {
  const events: string[] = [];
  const identity = { agent_id: "agent-id" };
  const agentApi = {
    resolveIdentity: jest.fn(
      async () => undefined as typeof identity | undefined,
    ),
    registerIdentity: jest.fn(async () => {
      events.push("register");
      return identity;
    }),
    nameAgent: jest.fn(async () => {
      events.push("name");
    }),
  };
  const files = {
    stat: jest.fn(async () => ({ isDirectory: () => true })),
    mkdir: jest.fn(async () => {
      events.push("mkdir");
    }),
    exists: jest.fn(async () => false),
    writeFile: jest.fn(async () => {
      events.push("write");
    }),
  };
  const chat = {
    createCodexThread: jest.fn(async () => {
      events.push("thread");
      return { thread_id: pending.threadId };
    }),
  };
  const create = () =>
    createNamedAgent({
      agentApi: agentApi as any,
      files: files as any,
      chat: chat as any,
      pending,
      name: "Research",
      description: "Explore code",
      projectTitle: "Project",
      workingDirectory: "/home/user",
    });
  return { agentApi, files, chat, events, create };
}

it("creates the chat thread before registering a named agent", async () => {
  const { agentApi, files, chat, events, create } = fixtures();
  await create();
  expect(events).toEqual(["mkdir", "write", "thread", "register", "name"]);
  expect(files.stat).toHaveBeenCalledWith("/home/user");
  expect(chat.createCodexThread).toHaveBeenCalledWith(
    expect.objectContaining({ thread_id: pending.threadId }),
  );
  expect(agentApi.nameAgent).toHaveBeenCalledWith(
    expect.objectContaining({ name: "research", description: "Explore code" }),
  );
});

it("does not overwrite a chat file or duplicate an existing thread on retry", async () => {
  const { agentApi, files, chat, create } = fixtures();
  files.exists.mockResolvedValue(true);
  chat.createCodexThread.mockRejectedValueOnce(
    new Error(`thread '${pending.threadId}' already exists`),
  );
  await create();
  expect(files.writeFile).not.toHaveBeenCalled();
  expect(agentApi.registerIdentity).toHaveBeenCalledTimes(1);
});

it("does not create anything when the working directory is invalid", async () => {
  const { agentApi, files, chat, create } = fixtures();
  files.stat.mockRejectedValueOnce(new Error("not found"));
  await expect(create()).rejects.toThrow("does not exist");
  expect(files.mkdir).not.toHaveBeenCalled();
  expect(chat.createCodexThread).not.toHaveBeenCalled();
  expect(agentApi.registerIdentity).not.toHaveBeenCalled();
});

it("uses the project filesystem client to restore directory checks after RPC", async () => {
  const fixture = fixtures();
  const stat = jest.fn(async () => ({ mode: 0o040755 }));
  const raw = {
    readdir: jest.fn(),
    stat,
    lstat: jest.fn(),
    watch: jest.fn(),
    constants: jest.fn(async () => ({ S_IFMT: 0o170000, S_IFDIR: 0o040000 })),
    mkdir: fixture.files.mkdir,
    exists: fixture.files.exists,
    writeFile: fixture.files.writeFile,
  };
  const files = fsClient({
    client: { call: () => raw } as any,
    subject: "fs.project-project-id",
  });
  await createNamedAgent({
    agentApi: fixture.agentApi as any,
    files,
    chat: fixture.chat as any,
    pending,
    name: "Research",
    description: "",
    projectTitle: "Project",
    workingDirectory: "/home/user",
  });
  expect(stat).toHaveBeenCalledWith("/home/user");
  expect(fixture.agentApi.registerIdentity).toHaveBeenCalledTimes(1);
});
