const fresh = jest.fn();
const owners = jest.fn();
const local = jest.fn();
jest.mock("./project-dangerous-auth", () => ({
  PROJECT_DANGEROUS_INTERNAL_AUTH: Symbol("project-dangerous-internal-auth"),
  requireDangerousProjectMutationAuth: (...args) => fresh(...args),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: jest.fn(),
  resolveProjectBays: (...args) => owners(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/projects/ownership", () => ({
  leaveOrDeleteProjectsForAccount: (...args) => local(...args),
}));
import { getHubApiRoute } from "@cocalc/conat/hub/api/routes";
import { leaveOrDeleteProjects } from "./projects";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const HERE = "22222222-2222-4222-8222-222222222222";
const THERE = "33333333-3333-4333-8333-333333333333";
const opts = {
  account_id: ACCOUNT,
  browser_id: "browser",
  session_hash: "session",
};

beforeEach(() => {
  jest.clearAllMocks();
  fresh.mockResolvedValue(undefined);
  owners.mockImplementation(
    async (ids: string[]) =>
      new Map(
        ids.map((id) => [id, { bay_id: id === THERE ? "bay-1" : "bay-0" }]),
      ),
  );
  local.mockImplementation(async ({ project_ids }) =>
    project_ids.map((project_id) => ({ project_id, action: "removed_self" })),
  );
});

it("is routed by project, one call per owning bay", () => {
  const route = getHubApiRoute("projects.leaveOrDeleteProjects");
  expect(route?.owner).toBe("projects");
  expect((route as any).errorResult(HERE, "boom")).toEqual({
    project_id: HERE,
    action: "error",
    error: "boom",
  });
});

it("requires fresh auth before anything else", async () => {
  fresh.mockRejectedValue(new Error("fresh auth is required"));
  await expect(
    leaveOrDeleteProjects({ ...opts, project_ids: [HERE] }),
  ).rejects.toThrow("fresh auth is required");
  expect(fresh).toHaveBeenCalledWith(opts);
  expect(owners).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
});

it("handles only this bay's projects, one result per project in order", async () => {
  const results = await leaveOrDeleteProjects({
    ...opts,
    project_ids: [THERE, HERE.toUpperCase(), "nope", HERE],
  });
  expect(results).toEqual([
    {
      project_id: THERE,
      action: "error",
      error: expect.stringContaining("stale route"),
    },
    { project_id: HERE, action: "removed_self" },
    { project_id: "nope", action: "error", error: "invalid project_id" },
  ]);
  expect(local).toHaveBeenCalledTimes(1);
  const [{ account_id, project_ids, hardDeleteOwnedProject }] =
    local.mock.calls[0];
  expect(account_id).toBe(ACCOUNT);
  expect(project_ids).toEqual([HERE]);
  // Owned projects are hard deleted through the API's guarded path.
  expect(typeof hardDeleteOwnedProject).toBe("function");
});

it("refuses more than MAX_PROJECTS_PER_CALL projects", async () => {
  await expect(
    leaveOrDeleteProjects({
      ...opts,
      project_ids: Array.from({ length: 1001 }, () => HERE),
    }),
  ).rejects.toThrow("at most 1000");
  expect(local).not.toHaveBeenCalled();
});

it("refuses more than one of its own projects in one call", async () => {
  const OTHER = "44444444-4444-4444-8444-444444444444";
  await expect(
    leaveOrDeleteProjects({ ...opts, project_ids: [HERE, OTHER] }),
  ).rejects.toThrow("at most 1 project(s) on one bay");
  expect(local).not.toHaveBeenCalled();
});
