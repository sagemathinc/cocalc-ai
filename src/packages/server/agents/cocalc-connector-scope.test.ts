/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

const mockReference = jest.fn();

jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  resolveProjectReferenceAllowRemote: (...args: any[]) =>
    mockReference(...args),
}));

import { issuableConnectorScope } from "./cocalc-connector-scope";

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
