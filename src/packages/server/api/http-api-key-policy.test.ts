export {};

import {
  assertHttpHubApiKeyAllowed,
  assertHttpProjectApiKeyAllowed,
} from "./http-api-key-policy";
import { recordApiKeyAuditEventSoon } from "./api-key-audit";
import { assertApiKeyProjectMembership } from "./project-membership-revocation";
jest.mock("./project-membership-revocation", () => ({
  assertApiKeyProjectMembership: jest.fn(async () => undefined),
}));

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
  it.each([
    "prepareInvitation",
    "reviewInvitation",
    "sendInvitation",
    "getInvitationOperation",
    "listPeopleContacts",
    "getPeopleContact",
    "listInvitationHistory",
    "getInvitationCounts",
  ])("denies invitation capability %s until phase 7", async (method) => {
    await expect(
      assertHttpHubApiKeyAllowed({
        principal,
        name: `collaborators.${method}`,
        args: [{ session_hash: "forged" }],
      }),
    ).rejects.toThrow("API keys are not allowed");
  });
  it("does not let management request scope invoke human approval", async () => {
    await expect(
      assertHttpHubApiKeyAllowed({
        principal: { ...principal, capabilities: ["api-key:revoke:request"] },
        name: "apiKeys.decideAction",
        args: [{ session_hash: "forged", decision: "execute" }],
      }),
    ).rejects.toThrow("API keys are not allowed");
  });
  beforeEach(() => {
    mockRecordApiKeyAuditEventSoon.mockClear();
    jest
      .mocked(assertApiKeyProjectMembership)
      .mockReset()
      .mockResolvedValue(undefined);
  });

  it("audits unreviewed hub RPC denials", async () => {
    await expect(
      assertHttpHubApiKeyAllowed({
        principal,
        name: "system.deleteAccount",
        args: [],
      }),
    ).rejects.toThrow(
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

  it("does not allow project:read keys to retrieve the project address", async () => {
    await expect(
      assertHttpHubApiKeyAllowed({
        principal: {
          ...principal,
          capabilities: ["project:read"],
          allowed_project_ids: ["proj-1"],
        },
        name: "projects.getProjectAddress",
        args: [{ project_id: "proj-1" }],
      }),
    ).rejects.toThrow("API keys are not allowed to call hub RPC");
  });

  it("audits missing project capability denials", async () => {
    await expect(
      assertHttpProjectApiKeyAllowed({
        principal,
        project_id: "proj-1",
      }),
    ).rejects.toThrow("API key lacks required capability 'project:exec'");
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

  it("does not flatten mixed project grants into legacy capabilities", async () => {
    const mixed = {
      ...principal,
      capabilities: [] as typeof principal.capabilities,
      allowed_project_ids: [],
      scope: {
        version: 1 as const,
        account: ["project:list" as const],
        projects: [
          {
            project_id: "11111111-1111-4111-8111-111111111111",
            capabilities: ["project:exec" as const],
          },
          {
            project_id: "22222222-2222-4222-8222-222222222222",
            capabilities: ["file:read" as const],
            viewer_read_roots: ["data"],
          },
        ],
      },
    };
    await expect(
      assertHttpProjectApiKeyAllowed({
        principal: mixed,
        project_id: mixed.scope.projects[0].project_id,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertHttpProjectApiKeyAllowed({
        principal: mixed,
        project_id: mixed.scope.projects[1].project_id,
      }),
    ).rejects.toThrow("API key lacks required capability 'project:exec'");
  });

  it("allows only the bounded project summary RPC with project:list", async () => {
    const listOnly = {
      ...principal,
      scope: {
        version: 1 as const,
        account: ["project:list" as const],
        projects: [],
      },
    };
    await expect(
      assertHttpHubApiKeyAllowed({
        principal: listOnly,
        name: "projects.listProjectSummaries",
        args: [{ limit: 20 }],
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertHttpHubApiKeyAllowed({
        principal: listOnly,
        name: "projects.listAccountProjectWindow",
        args: [],
      }),
    ).rejects.toThrow(/not allowed/);
  });
  it("awaits membership revocation for both project HTTP admission paths", async () => {
    const scoped = {
      ...principal,
      capabilities: ["project:exec", "project:read"] as const,
      allowed_project_ids: ["proj-1"],
    };
    const key = { ...scoped, capabilities: [...scoped.capabilities] };
    jest
      .mocked(assertApiKeyProjectMembership)
      .mockRejectedValue(Error("membership loss"));
    await expect(
      assertHttpProjectApiKeyAllowed({ principal: key, project_id: "proj-1" }),
    ).rejects.toThrow("membership loss");
    await expect(
      assertHttpHubApiKeyAllowed({
        principal: key,
        name: "projects.getProjectState",
        args: [{ project_id: "proj-1" }],
      }),
    ).rejects.toThrow("membership loss");
    expect(assertApiKeyProjectMembership).toHaveBeenCalledTimes(2);
  });
});
