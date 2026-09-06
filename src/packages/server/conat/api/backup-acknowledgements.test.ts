jest.mock("./util", () => ({ assertCollab: jest.fn() }));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: jest.fn(),
}));
jest.mock("@cocalc/server/project-backup/acknowledgements", () => ({
  backupAcknowledgementsLocal: jest.fn(),
}));
import { assertCollab } from "./util";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { backupAcknowledgementsLocal } from "@cocalc/server/project-backup/acknowledgements";
import { backupWarningAcknowledgements } from "./backup-acknowledgements";
const opts = {
  account_id: "account",
  project_id: "project",
  key: "a".repeat(64),
};
const remote = jest.fn();
beforeEach(() => {
  jest.resetAllMocks();
  jest
    .mocked(resolveAccountHomeBay)
    .mockResolvedValue({ home_bay_id: "bay-0" } as any);
  jest.mocked(backupAcknowledgementsLocal).mockResolvedValue([opts.key]);
  jest
    .mocked(createInterBayAccountLocalClient)
    .mockReturnValue({ backupWarningAcknowledgements: remote } as any);
  remote.mockResolvedValue([opts.key]);
});
it("authorizes before using the local home bay", async () => {
  expect(await backupWarningAcknowledgements(opts)).toEqual([opts.key]);
  expect(assertCollab).toHaveBeenCalledWith({
    account_id: opts.account_id,
    project_id: opts.project_id,
  });
  expect(backupAcknowledgementsLocal).toHaveBeenCalledWith(opts);
  expect(remote).not.toHaveBeenCalled();
});
it("routes to the account home bay without a local fallback", async () => {
  jest
    .mocked(resolveAccountHomeBay)
    .mockResolvedValue({ home_bay_id: "bay-2" } as any);
  await backupWarningAcknowledgements(opts);
  expect(createInterBayAccountLocalClient).toHaveBeenCalledWith({
    client: {},
    dest_bay: "bay-2",
  });
  remote.mockRejectedValueOnce(new Error("unavailable"));
  await expect(backupWarningAcknowledgements(opts)).rejects.toThrow(
    "unavailable",
  );
  expect(backupAcknowledgementsLocal).not.toHaveBeenCalled();
});
it("routes path scope and revocation to the account home bay unchanged", async () => {
  jest
    .mocked(resolveAccountHomeBay)
    .mockResolvedValue({ home_bay_id: "bay-2" } as any);
  const request = { ...opts, scope: "path" as const, remove: true };
  await backupWarningAcknowledgements(request);
  expect(remote).toHaveBeenCalledWith(request);
  expect(backupAcknowledgementsLocal).not.toHaveBeenCalled();
});
it("denies unauthenticated and noncollaborator requests before storage", async () => {
  await expect(
    backupWarningAcknowledgements({ ...opts, account_id: undefined }),
  ).rejects.toThrow("Sign in");
  jest
    .mocked(assertCollab)
    .mockRejectedValueOnce(new Error("not a collaborator"));
  await expect(backupWarningAcknowledgements(opts)).rejects.toThrow(
    "collaborator",
  );
  expect(resolveAccountHomeBay).not.toHaveBeenCalled();
  expect(backupAcknowledgementsLocal).not.toHaveBeenCalled();
  expect(remote).not.toHaveBeenCalled();
});
