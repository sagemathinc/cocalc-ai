const mockVerifyProjectHostAuthToken = jest.fn();
const mockGetProject = jest.fn();
const mockGetRow = jest.fn(() => ({ users: {} }));
const mockGetAccountRevokedBeforeMs = jest.fn(() => undefined);
const mockCallHub = jest.fn();
const mockGetMasterConatClient = jest.fn();

jest.mock("@cocalc/conat/auth/project-host-token", () => ({
  verifyProjectHostAuthToken: (...args: any[]) =>
    mockVerifyProjectHostAuthToken(...args),
}));

jest.mock("@cocalc/lite/hub/sqlite/database", () => ({
  getRow: (...args: any[]) => mockGetRow(...args),
}));

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCallHub(...args),
}));

jest.mock("./auth-public-key", () => ({
  getProjectHostAuthPublicKey: jest.fn(() => "public-key"),
}));

jest.mock("./sqlite/projects", () => ({
  getProject: (...args: any[]) => mockGetProject(...args),
}));

jest.mock("./sqlite/account-revocations", () => ({
  getAccountRevokedBeforeMs: (...args: any[]) =>
    mockGetAccountRevokedBeforeMs(...args),
}));

jest.mock("./master-status", () => ({
  getMasterConatClient: (...args: any[]) => mockGetMasterConatClient(...args),
}));

const getProjectHostManagedEgressBlockedMessageMock = jest.fn();

jest.mock("./managed-egress-runtime", () => ({
  getProjectHostManagedEgressBlockedMessage: (...args: any[]) =>
    getProjectHostManagedEgressBlockedMessageMock(...args),
}));

import { createProjectHostConatAuth } from "./conat-auth";
import { BOARD_WRITE_SERVICE } from "@cocalc/conat/persist/board-policy";

// Only the host's own system principal reaches the board write service: its
// subjects are `${BOARD_WRITE_SERVICE}.hub...`, which no account, agent or
// project may use (conat/persist/board-policy.ts).
describe("the board write service at the project host's broker", () => {
  const host_id = "00000000-1000-4000-8000-000000000099";
  const project_id = "00000000-1000-4000-8000-000000000000";
  const account_id = "00000000-1000-4000-8000-000000000001";
  const subjects = [
    `${BOARD_WRITE_SERVICE}.hub.id`,
    `${BOARD_WRITE_SERVICE}.hub.server.0.abc`,
    `${BOARD_WRITE_SERVICE}.hub.client.abc`,
  ];

  beforeEach(() => {
    mockGetRow.mockReturnValue({
      users: { [account_id]: { group: "owner" } },
    });
    mockGetProject.mockReturnValue({
      users: { [account_id]: { group: "owner" } },
    });
  });

  it("refuses accounts, agents and projects", async () => {
    const { isAllowed } = createProjectHostConatAuth({ host_id });
    const users: any[] = [
      { account_id },
      { account_id, auth_actor: "agent", auth_project_id: project_id },
      { project_id },
    ];
    for (const user of users) {
      for (const subject of subjects) {
        for (const type of ["pub", "sub"] as const) {
          await expect(isAllowed({ user, subject, type })).resolves.toBe(false);
        }
      }
    }
  });

  it("admits the host's system principal", async () => {
    const { isAllowed } = createProjectHostConatAuth({ host_id });
    for (const subject of subjects) {
      for (const type of ["pub", "sub"] as const) {
        await expect(
          isAllowed({ user: { hub_id: "system" } as any, subject, type }),
        ).resolves.toBe(true);
      }
    }
  });
});
