import { boundInvitationsApi } from "./invitations-api";

let mockAccount = "alice";
const mockPrepare = jest.fn();
const mockSend = jest.fn();
let mockClient = {
  hub: {
    collaborators: { prepareInvitation: mockPrepare, sendInvitation: mockSend },
  },
};
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getStore: () => ({ get: () => mockAccount }) },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    get conat_client() {
      return mockClient;
    },
  },
}));

beforeEach(() => {
  mockAccount = "alice";
  jest.clearAllMocks();
});

test("preparation binds the actor, not the recipient, to the workflow account", async () => {
  const input = {
    account_id: "forged",
    draft_id: "draft",
    expected_revision: 0,
    payload: {
      recipient: { kind: "account" as const, account_id: "bella" },
      projects: [],
      message: "Work together?",
      channels: { email: false, notification: true },
    },
  };
  await boundInvitationsApi("alice").prepareInvitation(input);
  expect(mockPrepare).toHaveBeenCalledWith({ ...input, account_id: "alice" });
});

test.each(["account", "connection"])(
  "late sends after a %s change are rejected",
  async (change) => {
    let resolve!: (result: unknown) => void;
    mockSend.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const api = boundInvitationsApi("alice");
    const promise = api.sendInvitation({
      draft_id: "d",
      revision: 1,
      review_id: "r",
      idempotency_key: "key",
    });
    if (change === "account") mockAccount = "bob";
    else mockClient = { ...mockClient };
    resolve({ operation_id: "sent" });
    await expect(promise).rejects.toThrow("session changed");
    await expect(
      api.sendInvitation({
        draft_id: "d",
        revision: 1,
        review_id: "r",
        idempotency_key: "key",
      }),
    ).rejects.toThrow("session changed");
    expect(mockSend).toHaveBeenCalledTimes(1);
  },
);
