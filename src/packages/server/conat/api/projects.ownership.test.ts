const fresh = jest.fn();
const admin = jest.fn();
const owned = jest.fn();
const local = jest.fn();
jest.mock("./dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (...args) => fresh(...args),
}));
jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args) => admin(...args),
}));
jest.mock("@cocalc/server/inter-bay/project-control", () => ({
  assertCurrentProjectOwnership: (...args) => owned(...args),
}));
jest.mock("@cocalc/server/projects/ownership", () => ({
  transferProjectOwnershipExplicitly: (...args) => local(...args),
}));
import { getHubApiRoute } from "@cocalc/conat/hub/api/routes";
import { transferProjectOwnership } from "./projects";

const opts = {
  account_id: "11111111-1111-4111-8111-111111111111",
  project_id: "22222222-2222-4222-8222-222222222222",
  from_account_id: "11111111-1111-4111-8111-111111111111",
  to_account_id: "33333333-3333-4333-8333-333333333333",
  browser_id: "browser",
  session_hash: "session",
};
beforeEach(() => {
  jest.clearAllMocks();
  fresh.mockResolvedValue(undefined);
  admin.mockResolvedValue(false);
  owned.mockResolvedValue(undefined);
});
it("is routed to the project's owning bay", () => {
  expect(getHubApiRoute("projects.transferProjectOwnership")?.key([opts])).toBe(
    opts.project_id,
  );
});
it("requires fresh auth before anything else, even for admins", async () => {
  admin.mockResolvedValue(true);
  fresh.mockRejectedValue(new Error("fresh auth required"));
  await expect(transferProjectOwnership(opts)).rejects.toThrow(
    "fresh auth required",
  );
  expect(owned).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
});
it("rejects impersonated ownership transfers", async () => {
  fresh.mockImplementationOnce(async ({ allow_actor_impersonation }) => {
    if (allow_actor_impersonation === false) {
      throw Object.assign(new Error("impersonation blocked"), {
        code: "impersonation_blocked",
      });
    }
  });
  await expect(transferProjectOwnership(opts)).rejects.toMatchObject({
    code: "impersonation_blocked",
  });
  expect(fresh).toHaveBeenCalledWith({
    account_id: opts.account_id,
    browser_id: opts.browser_id,
    session_hash: opts.session_hash,
    require_second_factor: "if_enabled",
    allow_actor_impersonation: false,
  });
  expect(admin).not.toHaveBeenCalled();
  expect(owned).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
});
it("transfers here once this bay owns the project, ignoring public admin flags", async () => {
  await transferProjectOwnership({ ...opts, trusted_admin: true } as any);
  expect(owned).toHaveBeenCalledWith({ project_id: opts.project_id });
  expect(local).toHaveBeenCalledWith({
    account_id: opts.account_id,
    project_id: opts.project_id,
    from_account_id: opts.from_account_id,
    to_account_id: opts.to_account_id,
    trusted_admin: false,
  });
});
it("takes admin status from isAdmin, which asks the actor's home bay", async () => {
  admin.mockResolvedValue(true);
  await transferProjectOwnership(opts);
  expect(admin).toHaveBeenCalledWith(opts.account_id);
  expect(local).toHaveBeenCalledWith(
    expect.objectContaining({ trusted_admin: true }),
  );
});
it("refuses on a bay that does not own the project", async () => {
  owned.mockRejectedValue(new Error("stale project routing"));
  await expect(transferProjectOwnership(opts)).rejects.toThrow(
    "stale project routing",
  );
  expect(local).not.toHaveBeenCalled();
});
