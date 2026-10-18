/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

const mockReference = jest.fn();

jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  resolveProjectReferenceAllowRemote: (...args: any[]) =>
    mockReference(...args),
}));

const mockKeyState = jest.fn();
jest.mock("@cocalc/server/api/key-authorization-state", () => ({
  getApiKeyAuthorizationState: (...args: any[]) => mockKeyState(...args),
}));

import {
  assertSoloProjectCapabilityInContext,
  issuableConnectorScope,
} from "./cocalc-connector-scope";

const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000009";
const source_project_id = "00000000-0000-4000-8000-000000000003";

const scope = {
  version: 1 as const,
  account: ["project:list" as const, "notifications:manage" as const],
  projects: [],
};

describe("issuableConnectorScope", () => {
  beforeEach(() => mockReference.mockReset());

  it("keeps notifications while the agent's project is the owner's alone", async () => {
    mockReference.mockResolvedValue({
      users: { [owner]: { group: "owner" } },
    });
    await expect(
      issuableConnectorScope({ account_id: owner, source_project_id, scope }),
    ).resolves.toEqual(scope);
    expect(mockReference).toHaveBeenCalledWith({
      account_id: owner,
      project_id: source_project_id,
      warmRoute: false,
    });
  });

  it("drops notifications when the project has other collaborators", async () => {
    mockReference.mockResolvedValue({
      users: {
        [owner]: { group: "owner" },
        [other]: { group: "collaborator" },
      },
    });
    await expect(
      issuableConnectorScope({ account_id: owner, source_project_id, scope }),
    ).resolves.toEqual({ ...scope, account: ["project:list"] });
  });

  it("drops notifications when membership cannot be confirmed", async () => {
    mockReference.mockRejectedValue(new Error("bay unreachable"));
    await expect(
      issuableConnectorScope({ account_id: owner, source_project_id, scope }),
    ).resolves.toEqual({ ...scope, account: ["project:list"] });
    mockReference.mockResolvedValue(null);
    await expect(
      issuableConnectorScope({ account_id: owner, source_project_id, scope }),
    ).resolves.toEqual({ ...scope, account: ["project:list"] });
  });

  it("does not look up the project for scopes without such privileges", async () => {
    const plain = { ...scope, account: ["project:list" as const] };
    await expect(
      issuableConnectorScope({
        account_id: owner,
        source_project_id,
        scope: plain,
      }),
    ).resolves.toBe(plain);
    expect(mockReference).not.toHaveBeenCalled();
  });
});

describe("assertSoloProjectCapabilityInContext", () => {
  const principal = { account_id: owner, key_id: "key-1", scope_revision: 3 };
  beforeEach(() => {
    mockReference.mockReset();
    mockKeyState.mockReset();
  });

  it("allows a turn key while its agent's project is the owner's alone", async () => {
    mockKeyState.mockResolvedValue({
      scope_revision: 3,
      connector_source_project_id: source_project_id,
    });
    mockReference.mockResolvedValue({ users: { [owner]: { group: "owner" } } });
    await expect(
      assertSoloProjectCapabilityInContext(principal),
    ).resolves.toBeUndefined();
    expect(mockReference).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: source_project_id }),
    );
  });

  it("refuses an already issued turn key once a collaborator was added", async () => {
    mockKeyState.mockResolvedValue({
      scope_revision: 3,
      connector_source_project_id: source_project_id,
    });
    mockReference.mockResolvedValue({
      users: { [owner]: { group: "owner" }, [other]: "collaborator" },
    });
    await expect(
      assertSoloProjectCapabilityInContext(principal),
    ).rejects.toMatchObject({ code: "api_key_shared_project" });
    mockReference.mockRejectedValue(new Error("owning bay unavailable"));
    await expect(
      assertSoloProjectCapabilityInContext(principal),
    ).rejects.toMatchObject({ code: "api_key_shared_project" });
  });

  it("leaves keys the person made alone, and fails closed on doubt", async () => {
    mockKeyState.mockResolvedValue({
      scope_revision: 3,
      connector_source_project_id: null,
    });
    await expect(
      assertSoloProjectCapabilityInContext(principal),
    ).resolves.toBeUndefined();
    expect(mockReference).not.toHaveBeenCalled();
    // An older home bay that cannot say whether this is a turn key.
    mockKeyState.mockResolvedValue({ scope_revision: 3 });
    await expect(
      assertSoloProjectCapabilityInContext(principal),
    ).rejects.toThrow("could not be confirmed");
    mockKeyState.mockResolvedValue({
      scope_revision: 4,
      connector_source_project_id: null,
    });
    await expect(
      assertSoloProjectCapabilityInContext(principal),
    ).rejects.toThrow("revoked or scope changed");
    mockKeyState.mockResolvedValue(null);
    await expect(
      assertSoloProjectCapabilityInContext(principal),
    ).rejects.toThrow("revoked");
  });
});
