import {
  requestApiKeyAction,
  decideApiKeyAction,
  listApiKeyActions,
} from "./key-action-routing";
import {
  requestApiKeyActionLocal,
  decideApiKeyActionLocal,
  listApiKeyActionsLocal,
} from "./key-actions";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";

const remoteRequest = jest.fn();
const remoteDecision = jest.fn();
const remoteList = jest.fn();
jest.mock("./key-actions", () => ({
  requestApiKeyActionLocal: jest.fn(),
  decideApiKeyActionLocal: jest.fn(),
  listApiKeyActionsLocal: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "fabric",
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: jest.fn(() => ({
    requestApiKeyAction: (...args) => remoteRequest(...args),
    decideApiKeyAction: (...args) => remoteDecision(...args),
    listApiKeyActions: (...args) => remoteList(...args),
  })),
}));

const principal = {
  account_id: "11111111-1111-4111-8111-111111111111",
  key_id: "requester-key",
  scope_revision: 2,
  auth_method: "api_key" as const,
};
const request = {
  request_id: "22222222-2222-4222-8222-222222222222",
  action: { kind: "revoke_api_key" as const, target_key_id: "target-key" },
};
beforeEach(() => {
  jest.clearAllMocks();
  remoteRequest.mockReset();
  remoteDecision.mockReset();
  remoteList.mockReset();
  jest
    .mocked(getClusterAccountById)
    .mockResolvedValue({ home_bay_id: "bay-0" } as any);
});

test("uses local implementation only at the resolved home", async () => {
  await requestApiKeyAction(principal, request);
  expect(requestApiKeyActionLocal).toHaveBeenCalledWith(principal, request);
  expect(createInterBayAccountLocalClient).not.toHaveBeenCalled();
});

test("pending reviews follow the same home route with bound human session", async () => {
  const opts = {
    account_id: principal.account_id,
    session_hash: "verified-session",
  };
  await listApiKeyActions(opts);
  expect(listApiKeyActionsLocal).toHaveBeenCalledWith(opts);
  jest
    .mocked(getClusterAccountById)
    .mockResolvedValue({ home_bay_id: "bay-2" } as any);
  await listApiKeyActions(opts);
  expect(remoteList).toHaveBeenCalledWith(opts);
  expect(listApiKeyActionsLocal).toHaveBeenCalledTimes(1);
});

test("remote request carries only authenticated identity and canonical action", async () => {
  jest
    .mocked(getClusterAccountById)
    .mockResolvedValue({ home_bay_id: "bay-2" } as any);
  await requestApiKeyAction(
    { ...principal, secret: "not-forwarded", scope: {} } as any,
    request,
  );
  expect(remoteRequest).toHaveBeenCalledWith({ principal, request });
  expect(createInterBayAccountLocalClient).toHaveBeenCalledWith({
    client: "fabric",
    dest_bay: "bay-2",
    timeout: 5000,
  });
  expect(requestApiKeyActionLocal).not.toHaveBeenCalled();
});

test("unknown home and remote failures do not retry execution locally", async () => {
  jest.mocked(getClusterAccountById).mockResolvedValue(undefined);
  await expect(requestApiKeyAction(principal, request)).rejects.toThrow(
    "resolve",
  );
  jest
    .mocked(getClusterAccountById)
    .mockResolvedValue({ home_bay_id: "bay-2" } as any);
  remoteDecision.mockRejectedValue(new Error("timeout: outcome unknown"));
  await expect(
    decideApiKeyAction({
      account_id: principal.account_id,
      session_hash: "bound-session",
      reviewed: {} as any,
      decision: "execute",
    }),
  ).rejects.toThrow("outcome unknown");
  expect(remoteDecision).toHaveBeenCalledTimes(1);
  expect(decideApiKeyActionLocal).not.toHaveBeenCalled();
  expect(requestApiKeyActionLocal).not.toHaveBeenCalled();
});

test("rejects client identity fields before selecting a route", async () => {
  await expect(
    requestApiKeyAction(principal, {
      ...request,
      account_id: principal.account_id,
    }),
  ).rejects.toThrow("unknown");
  expect(getClusterAccountById).not.toHaveBeenCalled();
});
