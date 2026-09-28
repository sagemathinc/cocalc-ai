import { openNotificationTarget } from "./open-target";

let mockAccount = "account";
let mockTab = "agents";
const mockAgent = jest.fn();
const mockResource = jest.fn();
const mockOpen = jest.fn();
const mockFile = jest.fn();
const mockRuntime = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (store) => ({
      get: () => (store === "account" ? mockAccount : mockTab),
    }),
    getProjectActions: () => ({ open_file: mockFile }),
  },
}));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: () => mockRuntime(),
}));
jest.mock("../agents/open-notification", () => ({
  openAgentNotification: (...args) => mockAgent(...args),
}));
jest.mock("../collaborators/workspace-api", () => ({
  boundCollaboratorsApi: () => ({ getResource: mockResource }),
}));
jest.mock("../collaborators/navigation", () => ({
  ...jest.requireActual("../collaborators/navigation"),
  openCollaborators: (...args) => mockOpen(...args),
}));
const target = {
  projectId: "project",
  path: "/human.chat",
  fragmentId: { thread: "thread", chat: "1234" },
};
const resource = {
  project_id: "project",
  kind: "conversation",
  resource_id: "thread",
  thread_id: "thread",
  chat_path: "/human.chat",
  personal: { alias: "chat2" },
};
beforeEach(() => {
  jest.clearAllMocks();
  mockAccount = "account";
  mockTab = "agents";
  mockAgent.mockResolvedValue(false);
  mockResource.mockResolvedValue(resource);
});

test("human replies open the Home conversation using its private alias, not a project file", async () => {
  expect(await openNotificationTarget(target)).toBe(true);
  expect(mockResource).toHaveBeenCalledWith({
    project_id: "project",
    kind: "conversation",
    resource_id: "thread",
  });
  expect(mockOpen).toHaveBeenCalledWith({
    view: "conversations",
    projectId: "project",
    resourceKind: "conversation",
    resourceId: "thread",
    alias: "chat2",
    aliasKind: "chats",
  });
  expect(mockRuntime).not.toHaveBeenCalled();
  expect(mockFile).not.toHaveBeenCalled();
});
test("the explicit notification thread takes precedence over the fragment", async () => {
  await openNotificationTarget({
    ...target,
    threadId: "thread",
    fragmentId: { thread: "old-thread" },
  });
  expect(mockResource).toHaveBeenCalledWith(
    expect.objectContaining({ resource_id: "thread" }),
  );
  expect(mockOpen).toHaveBeenCalled();
});
test("named agents keep their existing Home navigation", async () => {
  mockAgent.mockResolvedValueOnce(true);
  expect(await openNotificationTarget(target)).toBe(true);
  expect(mockResource).not.toHaveBeenCalled();
  expect(mockFile).not.toHaveBeenCalled();
});
test.each([
  null,
  { ...resource, kind: "agent" },
  { ...resource, chat_path: "/other.chat" },
  { ...resource, project_id: "other-project" },
  { ...resource, thread_id: "other-thread" },
])(
  "unmatched targets retain original file and message navigation: %j",
  async (value) => {
    mockResource.mockResolvedValueOnce(value);
    expect(await openNotificationTarget(target)).toBe(true);
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockFile).toHaveBeenCalledWith({
      path: target.path,
      chat: true,
      fragmentId: target.fragmentId,
    });
  },
);
test("lookup failure preserves legacy file navigation", async () => {
  mockResource.mockRejectedValueOnce(Error("directory offline"));
  expect(await openNotificationTarget(target)).toBe(true);
  expect(mockFile).toHaveBeenCalled();
});
test("outside Home, keep the project-file workflow", async () => {
  mockTab = "projects";
  expect(await openNotificationTarget(target)).toBe(true);
  expect(mockResource).not.toHaveBeenCalled();
  expect(mockFile).toHaveBeenCalled();
});
test.each([
  { ...target, fragmentId: { chat: "1234" } },
  { ...target, path: "notes.md" },
])(
  "non-chat or legacy threadless targets bypass conversation lookup",
  async (value) => {
    expect(await openNotificationTarget(value)).toBe(true);
    expect(mockResource).not.toHaveBeenCalled();
    expect(mockFile).toHaveBeenCalled();
  },
);
test.each(["account", "tab"])(
  "abandon a pending lookup after %s changes",
  async (change) => {
    mockResource.mockImplementationOnce(async () => {
      if (change === "account") mockAccount = "other-account";
      else mockTab = "projects";
      return resource;
    });
    expect(await openNotificationTarget(target)).toBe(false);
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockFile).not.toHaveBeenCalled();
  },
);
