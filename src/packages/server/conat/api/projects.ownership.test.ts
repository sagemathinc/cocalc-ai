const fresh = jest.fn();
const admin = jest.fn();
const resolve = jest.fn();
const local = jest.fn();
const remote = jest.fn();
const bridge = jest.fn(() => ({ transferProjectOwnership: remote }));
jest.mock("./project-dangerous-auth", () => ({
  requireDangerousProjectMutationAuth: (...args) => fresh(...args),
}));
jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args) => admin(...args),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...args) => resolve(...args),
}));
jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: () => ({ projectCollabInvite: bridge }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
}));
jest.mock("@cocalc/server/projects/ownership", () => ({
  transferProjectOwnershipExplicitly: (...args) => local(...args),
}));
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
  resolve.mockResolvedValue({ bay_id: "home" });
});
it("requires fresh auth before dispatch, even for admins", async () => {
  admin.mockResolvedValue(true);
  fresh.mockRejectedValue(new Error("fresh auth required"));
  await expect(transferProjectOwnership(opts)).rejects.toThrow(
    "fresh auth required",
  );
  expect(local).not.toHaveBeenCalled();
  expect(remote).not.toHaveBeenCalled();
});
it("dispatches locally only after resolving owning bay and ignores public admin flags", async () => {
  await transferProjectOwnership({ ...opts, trusted_admin: true } as any);
  expect(resolve).toHaveBeenCalledWith(opts.project_id);
  expect(local).toHaveBeenCalledWith({
    account_id: opts.account_id,
    project_id: opts.project_id,
    from_account_id: opts.from_account_id,
    to_account_id: opts.to_account_id,
    trusted_admin: false,
  });
  expect(remote).not.toHaveBeenCalled();
});
it("routes to the owning bay without forwarding session credentials", async () => {
  resolve.mockResolvedValue({ bay_id: "owner-bay" });
  admin.mockResolvedValue(true);
  await transferProjectOwnership(opts);
  expect(bridge).toHaveBeenCalledWith("owner-bay");
  expect(remote).toHaveBeenCalledWith({
    account_id: opts.account_id,
    project_id: opts.project_id,
    from_account_id: opts.from_account_id,
    to_account_id: opts.to_account_id,
    trusted_admin: true,
  });
  expect(local).not.toHaveBeenCalled();
});
it("does not fall back to local data when ownership cannot be resolved", async () => {
  resolve.mockResolvedValue(null);
  await expect(transferProjectOwnership(opts)).rejects.toThrow("not found");
  expect(local).not.toHaveBeenCalled();
});
