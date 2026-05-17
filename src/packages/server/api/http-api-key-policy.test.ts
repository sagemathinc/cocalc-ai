export {};

import {
  assertHttpHubApiKeyAllowed,
  assertHttpProjectApiKeyAllowed,
} from "./http-api-key-policy";
import { recordApiKeyAuditEventSoon } from "./api-key-audit";

jest.mock("./api-key-audit", () => ({
  __esModule: true,
  recordApiKeyAuditEventSoon: jest.fn(),
}));

const mockRecordApiKeyAuditEventSoon = jest.mocked(recordApiKeyAuditEventSoon);

const principal = {
  account_id: "acc-1",
  api_key_id: 1,
  key_id: "key-1",
  auth_method: "api_key" as const,
  capabilities: ["account:read" as const],
  allowed_project_ids: [],
};

describe("HTTP API key policy audit", () => {
  beforeEach(() => {
    mockRecordApiKeyAuditEventSoon.mockClear();
  });

  it("audits unreviewed hub RPC denials", () => {
    expect(() =>
      assertHttpHubApiKeyAllowed({
        principal,
        name: "system.deleteAccount",
        args: [],
      }),
    ).toThrow(
      "API keys are not allowed to call hub RPC 'system.deleteAccount'",
    );
    expect(mockRecordApiKeyAuditEventSoon).toHaveBeenCalledWith({
      event: "api_key_denied",
      value: {
        account_id: "acc-1",
        api_key_id: 1,
        key_id: "key-1",
        source: "http-conat-hub",
        rpc: "system.deleteAccount",
        reason: "hub RPC is not allowed for API keys",
        code: "api_key_rpc_denied",
      },
    });
  });

  it("audits missing project capability denials", () => {
    expect(() =>
      assertHttpProjectApiKeyAllowed({
        principal,
        project_id: "proj-1",
      }),
    ).toThrow("API key lacks required capability 'project:exec'");
    expect(mockRecordApiKeyAuditEventSoon).toHaveBeenCalledWith({
      event: "api_key_denied",
      value: {
        account_id: "acc-1",
        api_key_id: 1,
        key_id: "key-1",
        source: "http-conat-project",
        project_id: "proj-1",
        reason:
          "API key lacks required capability 'project:exec' for project proj-1",
        code: "api_key_project_capability_denied",
        capability: "project:exec",
      },
    });
  });
});
