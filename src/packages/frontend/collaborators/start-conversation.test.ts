import { createConversation } from "./start-conversation";
import type { DirectoryApi } from "./workspace-api";

const accountId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const threadId = "00000000-0000-5000-a000-000000000004";
let mockAccount = accountId;
const mockRequest = jest.fn();
const mockProjectConat = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getStore: () => ({ get: () => mockAccount }) },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: { projectConat: (...args) => mockProjectConat(...args) },
  },
}));

function options() {
  return {
    api: {
      ensureRoom: jest.fn().mockResolvedValue({
        project_id: projectId,
        room_id: "room",
        chat_path: "/room.chat",
      }),
    } as unknown as DirectoryApi,
    accountId,
    projectId,
    requestId,
    title: "Seminar",
    signal: new AbortController().signal,
    onProgress: jest.fn(),
    onDispatch: jest.fn(),
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockAccount = accountId;
  mockProjectConat.mockResolvedValue({ request: mockRequest });
  mockRequest.mockResolvedValue({ data: { thread_id: threadId } });
});

test("registers metadata then calls the authorized host service, never a file writer or agent API", async () => {
  const opts = options();
  await expect(createConversation(opts)).resolves.toEqual({
    project_id: projectId,
    kind: "conversation",
    resource_id: threadId,
  });
  expect(opts.api.ensureRoom).toHaveBeenCalledWith({
    project_id: projectId,
    request_id: requestId,
  });
  expect(mockProjectConat).toHaveBeenCalledWith({
    project_id: projectId,
    caller: "collaborators.createThread",
    requireRouting: true,
  });
  expect(mockRequest).toHaveBeenCalledWith(
    `services.account-${accountId}._.${projectId}._.collaborators`,
    [
      "createThread",
      [{ request_id: requestId, expected_room_id: "room", title: "Seminar" }],
    ],
    { timeout: 60_000, waitForInterest: true },
  );
  expect(opts.onDispatch).toHaveBeenCalledTimes(1);
  expect(opts.onDispatch.mock.invocationCallOrder[0]).toBeLessThan(
    mockRequest.mock.invocationCallOrder[0],
  );
});

test("missing routing does not dispatch a conversation request", async () => {
  const opts = options();
  mockProjectConat.mockRejectedValueOnce(
    Error("host routing info unavailable"),
  );
  await expect(createConversation(opts)).rejects.toThrow(
    "host routing info unavailable",
  );
  expect(opts.onDispatch).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});

test("lost acknowledgments retry the exact operation identity", async () => {
  const opts = options();
  mockRequest.mockRejectedValueOnce(Error("timeout"));
  await expect(createConversation(opts)).rejects.toThrow("timeout");
  await expect(createConversation(opts)).resolves.toMatchObject({
    resource_id: threadId,
  });
  expect(mockRequest.mock.calls[0]).toEqual(mockRequest.mock.calls[1]);
});

test.each(["cancel", "account"])(
  "%s changes after ensureRoom prevent the host mutation",
  async (kind) => {
    const opts = options();
    const abort = new AbortController();
    opts.signal = abort.signal;
    (opts.api.ensureRoom as jest.Mock).mockImplementation(async () => {
      if (kind === "cancel") abort.abort();
      else mockAccount = "different-account";
      return { project_id: projectId };
    });
    await expect(createConversation(opts)).rejects.toThrow(
      "cancelled or account changed",
    );
    expect(mockProjectConat).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  },
);

test("missing host acknowledgment is not reported as a created conversation", async () => {
  mockRequest.mockResolvedValueOnce({ data: {} });
  await expect(createConversation(options())).rejects.toThrow(
    "did not confirm",
  );
});
