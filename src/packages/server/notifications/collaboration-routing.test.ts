import {
  collaboratorsApi,
  collaboratorsControl,
  fetchCollaborationNotificationObligation,
} from "@cocalc/server/collaborators/api";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { createInterBayCollaboratorsClient } from "@cocalc/conat/inter-bay/collaborators";
import { readCollaborationNotificationObligation } from "@cocalc/database/postgres/collaborators/collaborators-notifications";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-changes",
  () => ({}),
);
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ collaborators_enabled: true }),
}));
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-common",
  () => ({
    uuid: jest.fn(),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-owner",
  () => ({}),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-discovery",
  () => ({}),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-access",
  () => ({}),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-project-page",
  () => ({}),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-checkpoint",
  () => ({}),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-adoption",
  () => ({}),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-notifications",
  () => ({
    readCollaborationNotificationObligation: jest.fn(),
  }),
);
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(),
}));
jest.mock("@cocalc/server/bay-directory", () => ({}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "trusted-fabric",
}));
jest.mock("@cocalc/server/collaborators/personal", () => ({}));
jest.mock("@cocalc/conat/inter-bay/collaborators", () => ({
  createInterBayCollaboratorsClient: jest.fn(),
}));

const job = {
  account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  membership_epoch: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};
beforeEach(() => {
  jest.clearAllMocks();
  (getConfiguredBayId as jest.Mock).mockReturnValue("owner-bay");
  (resolveProjectBay as jest.Mock).mockResolvedValue({
    bay_id: "owner-bay",
    epoch: 7,
  });
  (readCollaborationNotificationObligation as jest.Mock).mockResolvedValue(
    null,
  );
});

it("uses the local owner only after checking the directory route and epoch", async () => {
  expect(await fetchCollaborationNotificationObligation(job)).toBeNull();
  expect(readCollaborationNotificationObligation).toHaveBeenCalledWith(
    { ...job, route: { bay_id: "owner-bay", epoch: 7 } },
    { owning_bay_id: "owner-bay" },
  );
  expect(createInterBayCollaboratorsClient).not.toHaveBeenCalled();
});

it("routes foreign-owned project notification obligations over the trusted inter-bay fabric", async () => {
  (getConfiguredBayId as jest.Mock).mockReturnValue("account-home");
  const notificationObligation = jest.fn(async () => null);
  (createInterBayCollaboratorsClient as jest.Mock).mockReturnValue({
    notificationObligation,
  });
  await fetchCollaborationNotificationObligation(job);
  expect(createInterBayCollaboratorsClient).toHaveBeenCalledWith({
    client: "trusted-fabric",
    bay_id: "owner-bay",
  });
  expect(notificationObligation).toHaveBeenCalledWith({
    ...job,
    route: { bay_id: "owner-bay", epoch: 7 },
  });
  expect(readCollaborationNotificationObligation).not.toHaveBeenCalled();
});

it("rejects stale owner epochs instead of reading a local project shortcut", async () => {
  await expect(
    collaboratorsControl.notificationObligation({
      ...job,
      route: { bay_id: "owner-bay", epoch: 6 },
    }),
  ).rejects.toThrow("stale");
  expect(readCollaborationNotificationObligation).not.toHaveBeenCalled();
});

it("never registers notificationObligation on the authenticated-account public API", () => {
  expect("notificationObligation" in collaboratorsApi).toBe(false);
});
