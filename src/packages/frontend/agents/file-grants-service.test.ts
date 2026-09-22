import { contextForFileGrants } from "./file-grants-service";

const resolveIdentity = jest.fn();
const listFileGrants = jest.fn();
let accountId = "alice";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({ get: () => accountId }),
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        agent: {
          resolveIdentity: (...args) => resolveIdentity(...args),
          listFileGrants: (...args) => listFileGrants(...args),
        },
      },
    },
  },
}));

const request = {
  accountId: "alice",
  projectId: "00000000-0000-4000-8000-000000000001",
  path: "/home/user/agent.chat",
  threadId: "thread",
};

beforeEach(() => {
  jest.clearAllMocks();
  accountId = "alice";
  resolveIdentity.mockResolvedValue({
    agent_id: "00000000-0000-4000-8000-000000000002",
  });
  listFileGrants.mockResolvedValue([
    {
      grant_id: "00000000-0000-4000-8000-000000000003",
      target_project_id: "00000000-0000-4000-8000-000000000004",
      roots: ["docs"],
    },
  ]);
});

test("renders exact identity-only CLI commands for active grants", async () => {
  const context = await contextForFileGrants(request);
  expect(context).toContain(
    "cocalc project file grant cat --project 00000000-0000-4000-8000-000000000004 <path>",
  );
  expect(context).toContain("roots: docs");
});

test("returns no context before an identity or grants exist", async () => {
  resolveIdentity.mockResolvedValue(undefined);
  expect(await contextForFileGrants(request)).toBe("");
  expect(listFileGrants).not.toHaveBeenCalled();
});

test("does not leak grants after the signed-in account changes", async () => {
  listFileGrants.mockImplementationOnce(async () => {
    accountId = "bob";
    return [];
  });
  await expect(contextForFileGrants(request)).rejects.toThrow(
    "Account changed",
  );
});
