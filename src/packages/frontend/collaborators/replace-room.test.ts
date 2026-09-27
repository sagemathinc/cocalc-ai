import { collaborationRoomReplacementOperationId } from "@cocalc/util/collaboration-room-replacement";
import { replaceConversationRoom } from "./replace-room";

const accountId = "11111111-1111-4111-8111-111111111111";
const request = {
  version: 1 as const,
  project_id: "22222222-2222-4222-8222-222222222222",
  request_id: "33333333-3333-4333-8333-333333333333",
  expected_room_id: "44444444-4444-4444-8444-444444444444",
  expected_chat_path: "/home/user/old.chat",
};
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
const result = {
  outcome: "ready",
  operation_id: collaborationRoomReplacementOperationId(
    request.project_id,
    accountId,
    request.request_id,
  ),
  room: {
    project_id: request.project_id,
    room_id: "55555555-5555-4555-8555-555555555555",
    chat_path: "/home/user/new.chat",
    initialized: true,
  },
};
beforeEach(() => {
  jest.clearAllMocks();
  mockAccount = accountId;
  mockProjectConat.mockResolvedValue({ request: mockRequest });
  mockRequest.mockResolvedValue({ data: result });
});
test("replacement routes directly to the account-bound room service, retaining retry CAS", async () => {
  const options = { accountId, request, signal: new AbortController().signal };
  expect(await replaceConversationRoom(options)).toEqual(result);
  await replaceConversationRoom(options);
  expect(mockRequest.mock.calls[0]).toEqual(mockRequest.mock.calls[1]);
  expect(mockProjectConat).toHaveBeenCalledWith({
    project_id: request.project_id,
    caller: "collaborators.replaceRoom",
    requireRouting: true,
  });
  expect(mockRequest).toHaveBeenCalledWith(
    `services.account-${accountId}._.${request.project_id}._.collaborators`,
    ["replaceRoom", [request]],
    { timeout: 60_000, waitForInterest: true },
  );
});
test.each(["cancel", "account"])(
  "%s during routing prevents mutation",
  async (mode) => {
    const abort = new AbortController();
    mockProjectConat.mockImplementationOnce(async () => {
      if (mode === "cancel") abort.abort();
      else mockAccount = "another-account";
      return { request: mockRequest };
    });
    await expect(
      replaceConversationRoom({ accountId, request, signal: abort.signal }),
    ).rejects.toThrow("session changed");
    expect(mockRequest).not.toHaveBeenCalled();
  },
);
test("session switch after commit cannot publish a late success into another account", async () => {
  mockRequest.mockImplementationOnce(async () => {
    mockAccount = "another-account";
    return { data: result };
  });
  await expect(
    replaceConversationRoom({
      accountId,
      request,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("session changed");
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
test.each([
  { operation_id: "different" },
  { outcome: "unknown" },
  {
    room: { project_id: request.project_id, room_id: request.expected_room_id },
  },
])("rejects inconsistent acknowledgements %j", async (patch) => {
  mockRequest.mockResolvedValueOnce({ data: { ...result, ...patch } });
  await expect(
    replaceConversationRoom({
      accountId,
      request,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/not confirmed|different/);
});
