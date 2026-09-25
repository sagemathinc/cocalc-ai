export {};

import { createHash } from "node:crypto";
import { viewerPolicyForApiKeyGrant } from "@cocalc/util/api-key-scope";

const accountId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const hostId = "00000000-0000-4000-8000-000000000003";
const getStateMock = jest.fn();
const getReferenceMock = jest.fn();

jest.mock("@cocalc/server/api/key-authorization-state", () => ({
  getApiKeyAuthorizationState: (...args: any[]) => getStateMock(...args),
}));
jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  resolveProjectReferenceForMemberAllowRemote: (...args: any[]) =>
    getReferenceMock(...args),
}));

describe("project-host API key viewer policy lookup", () => {
  const scope = {
    version: 1 as const,
    account: [],
    projects: [
      {
        project_id: projectId,
        capabilities: ["file:read" as const],
        viewer_read_roots: ["data"],
      },
    ],
  };
  const policy = viewerPolicyForApiKeyGrant(scope, projectId)!;
  const hash = createHash("sha256")
    .update(JSON.stringify(policy))
    .digest("hex");
  const opts = {
    host_id: hostId,
    account_id: accountId,
    key_id: "key-id-123",
    scope_revision: 4,
    project_id: projectId,
    viewer_policy_hash: hash,
  };

  beforeEach(() => {
    getStateMock.mockReset();
    getReferenceMock.mockReset();
    getStateMock.mockResolvedValue({ scope_revision: 4, scope });
    getReferenceMock.mockResolvedValue({
      host_id: hostId,
      users: { [accountId]: { group: "viewer" } },
    });
  });

  it("returns only the matching live policy for the current host", async () => {
    const { getViewerReadPolicy } = await import("./api-keys");
    await expect(getViewerReadPolicy(opts)).resolves.toEqual(policy);
    expect(getStateMock).toHaveBeenCalledWith({
      account_id: accountId,
      key_id: "key-id-123",
    });
  });

  it("denies key edits, policy substitution, migration, and missing host identity", async () => {
    const { getViewerReadPolicy } = await import("./api-keys");
    getStateMock.mockResolvedValueOnce({ scope_revision: 5, scope });
    await expect(getViewerReadPolicy(opts)).rejects.toThrow("scope changed");
    await expect(
      getViewerReadPolicy({ ...opts, viewer_policy_hash: "a".repeat(64) }),
    ).rejects.toThrow("policy has changed");
    getReferenceMock.mockResolvedValueOnce({
      host_id: "00000000-0000-4000-8000-000000000004",
      users: { [accountId]: { group: "viewer" } },
    });
    await expect(getViewerReadPolicy(opts)).rejects.toThrow("not authorized");
    await expect(
      getViewerReadPolicy({ ...opts, host_id: undefined }),
    ).rejects.toThrow("host authorization is required");
  });
});
