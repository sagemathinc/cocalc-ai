import {
  collaboratorsApi,
  collaboratorsControl,
  fetchCollaborationNotificationPage,
} from "@cocalc/server/collaborators/api";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { createInterBayCollaboratorsClient } from "@cocalc/conat/inter-bay/collaborators";
import { readCollaborationNotificationPage } from "@cocalc/database/postgres/collaborators/collaborators-notifications";

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
    readCollaborationNotificationPage: jest.fn(),
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
  claim_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  grant_request_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  generation: null,
  cursor: null,
};
beforeEach(() => {
  jest.clearAllMocks();
  (getConfiguredBayId as jest.Mock).mockReturnValue("owner-bay");
  (resolveProjectBay as jest.Mock).mockResolvedValue({
    bay_id: "owner-bay",
    epoch: 7,
  });
  (readCollaborationNotificationPage as jest.Mock).mockResolvedValue({
    allowed: false,
  });
});

it("uses the local owner only after checking the directory route and epoch", async () => {
  expect(await fetchCollaborationNotificationPage(job, 25)).toEqual({
    allowed: false,
  });
  expect(readCollaborationNotificationPage).toHaveBeenCalledWith(
    job,
    { owning_bay_id: "owner-bay" },
    25,
  );
  expect(createInterBayCollaboratorsClient).not.toHaveBeenCalled();
});

it("routes foreign-owned project notification pages over the trusted inter-bay fabric", async () => {
  (getConfiguredBayId as jest.Mock).mockReturnValue("account-home");
  const notificationPage = jest.fn(async () => ({ allowed: false }));
  (createInterBayCollaboratorsClient as jest.Mock).mockReturnValue({
    notificationPage,
  });
  await fetchCollaborationNotificationPage(job, 25);
  expect(createInterBayCollaboratorsClient).toHaveBeenCalledWith({
    client: "trusted-fabric",
    bay_id: "owner-bay",
  });
  expect(notificationPage).toHaveBeenCalledWith({
    job,
    limit: 25,
    route: { bay_id: "owner-bay", epoch: 7 },
  });
  expect(readCollaborationNotificationPage).not.toHaveBeenCalled();
});

it("rejects stale owner epochs instead of reading a local project shortcut", async () => {
  await expect(
    collaboratorsControl.notificationPage({
      job,
      limit: 25,
      route: { bay_id: "owner-bay", epoch: 6 },
    }),
  ).rejects.toThrow("stale");
  expect(readCollaborationNotificationPage).not.toHaveBeenCalled();
});

it("never registers notificationPage on the authenticated-account public API", () => {
  expect("notificationPage" in collaboratorsApi).toBe(false);
});
