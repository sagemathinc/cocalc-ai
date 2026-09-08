import { adminPrepareProjectRemediation } from "./legacy-migration";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import * as local from "@cocalc/server/legacy-migration";

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(),
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => "seed",
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "fabric",
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: jest.fn(),
}));
jest.mock("@cocalc/server/legacy-migration", () => ({
  adminPrepareProjectRemediation: jest.fn(),
}));
jest.mock("./dangerous-session-auth", () => ({
  requireDangerousSessionAuth: jest.fn(),
}));

describe("admin failed-restore preparation routing", () => {
  const opts = {
    account_id: "admin",
    project_id: "project",
    allow_failed_restore: true,
    reason: "Preserve newer files",
    support_reference: "Support case",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(isAdmin).mockResolvedValue(true);
    jest.mocked(getConfiguredBayId).mockReturnValue("seed");
  });

  it("rejects a non-admin before accessing either bay", async () => {
    jest.mocked(isAdmin).mockResolvedValue(false);
    await expect(adminPrepareProjectRemediation(opts)).rejects.toThrow(
      "admin privileges required",
    );
    expect(local.adminPrepareProjectRemediation).not.toHaveBeenCalled();
    expect(createInterBayAccountLocalClient).not.toHaveBeenCalled();
  });

  it("forwards the explicit override and audit context on the seed bay", async () => {
    await adminPrepareProjectRemediation(opts);
    expect(local.adminPrepareProjectRemediation).toHaveBeenCalledWith(opts);
  });

  it("routes preparation to the authoritative seed bay", async () => {
    jest.mocked(getConfiguredBayId).mockReturnValue("other");
    const prepare = jest.fn().mockResolvedValue({ preparation_only: true });
    jest.mocked(createInterBayAccountLocalClient).mockReturnValue({
      legacyMigrationAdminPrepareProjectRemediation: prepare,
    } as unknown as ReturnType<typeof createInterBayAccountLocalClient>);
    await expect(adminPrepareProjectRemediation(opts)).resolves.toEqual({
      preparation_only: true,
    });
    expect(createInterBayAccountLocalClient).toHaveBeenCalledWith({
      client: "fabric",
      dest_bay: "seed",
      timeout: 6 * 60 * 60 * 1000,
    });
    expect(prepare).toHaveBeenCalledWith(opts);
    expect(local.adminPrepareProjectRemediation).not.toHaveBeenCalled();
  });
});
