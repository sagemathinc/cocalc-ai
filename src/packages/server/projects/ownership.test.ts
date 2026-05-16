/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const poolQueryMock = jest.fn();
const clientQueryMock = jest.fn();
const releaseMock = jest.fn();
const hardDeleteProjectMock = jest.fn();
const appendProjectOutboxEventForProjectMock = jest.fn();
const assertProjectNotRehomingMock = jest.fn();
const publishAccountFeedEventBestEffortMock = jest.fn();
const publishProjectAccountFeedEventsBestEffortMock = jest.fn();
const syncProjectUsersOnHostMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: poolQueryMock,
    connect: jest.fn(async () => ({
      query: clientQueryMock,
      release: releaseMock,
    })),
  })),
}));

jest.mock("@cocalc/server/projects/hard-delete", () => ({
  __esModule: true,
  hardDeleteProject: (...args: any[]) => hardDeleteProjectMock(...args),
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  __esModule: true,
  appendProjectOutboxEventForProject: (...args: any[]) =>
    appendProjectOutboxEventForProjectMock(...args),
}));

jest.mock("@cocalc/database/postgres/project-rehome-fence", () => ({
  __esModule: true,
  assertProjectNotRehoming: (...args: any[]) =>
    assertProjectNotRehomingMock(...args),
}));

jest.mock("@cocalc/server/account/feed", () => ({
  __esModule: true,
  publishAccountFeedEventBestEffort: (...args: any[]) =>
    publishAccountFeedEventBestEffortMock(...args),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  __esModule: true,
  publishProjectAccountFeedEventsBestEffort: (...args: any[]) =>
    publishProjectAccountFeedEventsBestEffortMock(...args),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  syncProjectUsersOnHost: (...args: any[]) =>
    syncProjectUsersOnHostMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const COLLABORATOR_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_COLLABORATOR_ID = "44444444-4444-4444-8444-444444444444";

function projectRow(users: Record<string, { group: string }>) {
  return {
    project_id: PROJECT_ID,
    title: "Project",
    users,
    last_active: {},
    usage_account_id: OWNER_ID,
    runtime_sponsor_account_id: OWNER_ID,
  };
}

describe("project ownership", () => {
  beforeEach(() => {
    jest.resetModules();
    poolQueryMock.mockReset();
    clientQueryMock.mockReset();
    releaseMock.mockReset();
    hardDeleteProjectMock.mockReset();
    appendProjectOutboxEventForProjectMock.mockReset();
    assertProjectNotRehomingMock.mockReset();
    publishAccountFeedEventBestEffortMock.mockReset();
    publishProjectAccountFeedEventsBestEffortMock.mockReset();
    syncProjectUsersOnHostMock.mockReset();
    assertProjectNotRehomingMock.mockResolvedValue(undefined);
    appendProjectOutboxEventForProjectMock.mockResolvedValue(undefined);
    publishAccountFeedEventBestEffortMock.mockResolvedValue(undefined);
    publishProjectAccountFeedEventsBestEffortMock.mockResolvedValue(undefined);
    syncProjectUsersOnHostMock.mockResolvedValue(undefined);
  });

  it("transfers ownership and moves owner-derived attribution", async () => {
    clientQueryMock.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (`${sql}`.includes("SELECT") && `${sql}`.includes("FOR UPDATE")) {
        return {
          rows: [
            projectRow({
              [OWNER_ID]: { group: "owner" },
              [COLLABORATOR_ID]: { group: "collaborator" },
            }),
          ],
        };
      }
      if (`${sql}`.includes("UPDATE projects")) {
        const users = JSON.parse(params?.[1]);
        expect(users[OWNER_ID]).toBeUndefined();
        expect(users[COLLABORATOR_ID].group).toBe("owner");
        expect(params?.[2]).toBe(COLLABORATOR_ID);
        expect(params?.[3]).toBe(COLLABORATOR_ID);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    });

    const { transferProjectOwnership } = await import("./ownership");
    await expect(
      transferProjectOwnership({
        project_id: PROJECT_ID,
        from_account_id: OWNER_ID,
        to_account_id: COLLABORATOR_ID,
      }),
    ).resolves.toMatchObject({
      project_id: PROJECT_ID,
      from_account_id: OWNER_ID,
      to_account_id: COLLABORATOR_ID,
      usage_account_id: COLLABORATOR_ID,
      runtime_sponsor_account_id: COLLABORATOR_ID,
    });

    expect(appendProjectOutboxEventForProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "project.membership_changed",
        project_id: PROJECT_ID,
      }),
    );
    expect(publishAccountFeedEventBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: OWNER_ID,
        event: expect.objectContaining({ type: "project.remove" }),
      }),
    );
  });

  it("chooses the most recently active collaborator for ownership transfer", async () => {
    const { chooseProjectOwnershipTransferTarget } =
      await import("./ownership");
    expect(
      chooseProjectOwnershipTransferTarget(
        {
          [OWNER_ID]: { group: "owner" },
          [OTHER_COLLABORATOR_ID]: { group: "collaborator" },
          [COLLABORATOR_ID]: { group: "collaborator" },
        },
        OWNER_ID,
        {
          [OTHER_COLLABORATOR_ID]: "2026-05-16T12:00:00.000Z",
          [COLLABORATOR_ID]: "2026-05-16T11:00:00.000Z",
        },
      ),
    ).toBe(OTHER_COLLABORATOR_ID);
  });

  it("uses account id as the transfer tie-breaker when activity is unavailable", async () => {
    const { chooseProjectOwnershipTransferTarget } =
      await import("./ownership");
    expect(
      chooseProjectOwnershipTransferTarget(
        {
          [OWNER_ID]: { group: "owner" },
          [OTHER_COLLABORATOR_ID]: { group: "collaborator" },
          [COLLABORATOR_ID]: { group: "collaborator" },
        },
        OWNER_ID,
      ),
    ).toBe(COLLABORATOR_ID);
  });

  it("hard-deletes owner-only projects during account deletion", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        projectRow({
          [OWNER_ID]: { group: "owner" },
        }),
      ],
    });
    hardDeleteProjectMock.mockResolvedValueOnce({
      project_id: PROJECT_ID,
    });

    const { disposeOwnedProjectsForAccountDeletion } =
      await import("./ownership");
    await expect(
      disposeOwnedProjectsForAccountDeletion(OWNER_ID),
    ).resolves.toEqual([
      {
        project_id: PROJECT_ID,
        action: "hard_deleted",
      },
    ]);
    expect(hardDeleteProjectMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      account_id: OWNER_ID,
    });
  });
});
