import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  applyCollaborationProjection,
  claimCollaborationProjectionJobs,
} from "@cocalc/database/postgres/collaborators/collaborators-projection";
import { syncCollaboratorsSchema } from "@cocalc/database/postgres/collaborators/collaborators-common";
import { claimCollaborationAccess } from "@cocalc/database/postgres/collaborators/collaborators-access";
import { fetchCollaborationNotificationPage } from "@cocalc/server/collaborators/api";
import {
  runCollaboratorsMaintenance,
  startCollaboratorsMaintenance,
  stopCollaboratorsMaintenance,
} from "@cocalc/server/collaborators/maintenance";
import {
  ensureCollaborationNotificationSchema,
  runCollaborationNotificationMaintenance,
} from "./collaboration-state";

jest.mock("@cocalc/backend/logger", () => () => ({ warn: jest.fn() }));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
}));
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-projection",
  () => ({
    applyCollaborationProjection: jest.fn(),
    claimCollaborationProjectionJobs: jest.fn(),
    cleanCollaborationProjections: jest.fn(),
    failCollaborationProjection: jest.fn(),
    seedCollaborationProjectionJobs: jest.fn(),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-common",
  () => ({
    syncCollaboratorsSchema: jest.fn(),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-owner",
  () => ({
    compactNextCollaborationProject: jest.fn(),
  }),
);
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-access",
  () => ({
    applyCollaborationAccess: jest.fn(),
    claimCollaborationAccess: jest.fn(),
    failCollaborationAccess: jest.fn(),
  }),
);
jest.mock("@cocalc/server/collaborators/api", () => ({
  fetchCollaborationProjection: jest.fn(),
  fetchCollaborationAccessBatches: jest.fn(),
  fetchCollaborationNotificationPage: jest.fn(),
}));
jest.mock("./collaboration-state", () => ({
  ensureCollaborationNotificationSchema: jest.fn(),
  runCollaborationNotificationMaintenance: jest.fn(),
}));

beforeEach(() => {
  stopCollaboratorsMaintenance();
  jest.resetAllMocks();
  (getServerSettings as jest.Mock).mockResolvedValue({
    collaborators_enabled: true,
  });
  (claimCollaborationProjectionJobs as jest.Mock).mockResolvedValue([]);
  (claimCollaborationAccess as jest.Mock).mockResolvedValue([]);
});
afterEach(() => {
  stopCollaboratorsMaintenance();
});

it("the existing maintenance lifecycle invokes durable notifications after projection application", async () => {
  (claimCollaborationProjectionJobs as jest.Mock).mockResolvedValue([
    { account_id: "account", project_id: "project" },
  ]);
  await runCollaboratorsMaintenance();
  expect(runCollaborationNotificationMaintenance).toHaveBeenCalledWith(
    fetchCollaborationNotificationPage,
  );
  expect(
    (applyCollaborationProjection as jest.Mock).mock.invocationCallOrder[0],
  ).toBeLessThan(
    (runCollaborationNotificationMaintenance as jest.Mock).mock
      .invocationCallOrder[0],
  );
});

it("does not deliver when the feature is disabled", async () => {
  (getServerSettings as jest.Mock).mockResolvedValue({
    collaborators_enabled: false,
  });
  await runCollaboratorsMaintenance();
  expect(runCollaborationNotificationMaintenance).not.toHaveBeenCalled();
});

it("initializes notification state before the maintenance timer is started", async () => {
  await startCollaboratorsMaintenance();
  expect(syncCollaboratorsSchema).toHaveBeenCalledTimes(1);
  expect(ensureCollaborationNotificationSchema).toHaveBeenCalledTimes(1);
  expect(
    (syncCollaboratorsSchema as jest.Mock).mock.invocationCallOrder[0],
  ).toBeLessThan(
    (ensureCollaborationNotificationSchema as jest.Mock).mock
      .invocationCallOrder[0],
  );
});

it("releases the single-flight guard after a delivery-store failure", async () => {
  (runCollaborationNotificationMaintenance as jest.Mock).mockRejectedValueOnce(
    Error("database unavailable"),
  );
  await expect(runCollaboratorsMaintenance()).rejects.toThrow(
    "database unavailable",
  );
  await runCollaboratorsMaintenance();
  expect(runCollaborationNotificationMaintenance).toHaveBeenCalledTimes(2);
});
