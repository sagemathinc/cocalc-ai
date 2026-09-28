/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import callHub from "@cocalc/conat/hub/call-hub";
import { createCredentialHttpRelay } from "./credential-http-relay";
import { createAnthropicAccountCredentialRelay } from "./anthropic-credential-relay";

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("../master-conat-client", () => ({
  getMasterConatClient: () => ({ id: "client" }),
}));
jest.mock("../sqlite/hosts", () => ({
  getLocalHostId: () => "host-a",
}));
jest.mock("./credential-http-relay", () => ({
  createCredentialHttpRelay: jest.fn(),
}));

const PROJECT_ID = "1892b11a-6c63-4a92-988d-01dcddc0bc79";
const ACCOUNT_ID = "8a52c640-079f-496d-85cb-0147bdf9fd6d";
const CREDENTIAL_ID = "2413dc6d-028a-471f-a3b4-6ddc59fe6cc6";
const mockCallHub = callHub as jest.MockedFunction<typeof callHub>;
const mockCreateRelay = createCredentialHttpRelay as jest.MockedFunction<
  typeof createCredentialHttpRelay
>;
const relay = { socketPath: "/relay/a.sock", token: "cap", close: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  relay.close.mockResolvedValue(undefined);
  mockCreateRelay.mockResolvedValue(relay);
});

test("resolves one exact account credential and creates a bounded relay", async () => {
  mockCallHub
    .mockResolvedValueOnce({
      id: CREDENTIAL_ID,
      payload: "sk-ant-account-secret",
      metadata: { cocalc_credential_profile: "anthropic-api-key-v1" },
    })
    .mockResolvedValueOnce(true);
  await expect(
    createAnthropicAccountCredentialRelay({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      credentialId: CREDENTIAL_ID,
      socketPath: "/relay/a.sock",
    }),
  ).resolves.toBe(relay);
  expect(mockCallHub.mock.calls[0][0]).toMatchObject({
    host_id: "host-a",
    name: "hosts.getExternalCredential",
    args: [
      {
        project_id: PROJECT_ID,
        selector: {
          provider: "anthropic",
          kind: "anthropic-api-key",
          scope: "account",
          owner_account_id: ACCOUNT_ID,
        },
        credential_id: CREDENTIAL_ID,
      },
    ],
  });
  expect(mockCreateRelay).toHaveBeenCalledWith({
    socketPath: "/relay/a.sock",
    upstream: "https://api.anthropic.com",
    allowedPathPrefix: "/v1/",
    allowedMethods: ["GET", "POST"],
    credential: { header: "x-api-key", value: "sk-ant-account-secret" },
    authorize: expect.any(Function),
  });
});

test("fails closed on malformed IDs and wrong provider profiles", async () => {
  await expect(
    createAnthropicAccountCredentialRelay({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      credentialId: "..",
      socketPath: "/relay/a.sock",
    }),
  ).rejects.toThrow("Invalid");
  expect(mockCallHub).not.toHaveBeenCalled();

  mockCallHub.mockResolvedValueOnce({
    id: CREDENTIAL_ID,
    payload: "other-secret",
    metadata: { cocalc_credential_profile: "some-other-profile" },
  });
  await expect(
    createAnthropicAccountCredentialRelay({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      credentialId: CREDENTIAL_ID,
      socketPath: "/relay/a.sock",
    }),
  ).rejects.toThrow("unavailable or revoked");
  expect(mockCreateRelay).not.toHaveBeenCalled();
});

test("closes a relay if exact credential authority changes before use", async () => {
  mockCallHub
    .mockResolvedValueOnce({
      id: CREDENTIAL_ID,
      payload: "sk-ant-account-secret",
      metadata: { cocalc_credential_profile: "anthropic-api-key-v1" },
    })
    .mockResolvedValueOnce(false);
  await expect(
    createAnthropicAccountCredentialRelay({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      credentialId: CREDENTIAL_ID,
      socketPath: "/relay/a.sock",
    }),
  ).rejects.toThrow("unavailable or revoked");
  expect(relay.close).toHaveBeenCalledTimes(1);
});
