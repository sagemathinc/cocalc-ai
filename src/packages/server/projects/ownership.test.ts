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

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));

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
const assertOwnershipRecipientMock = jest.fn();
jest.mock("./ownership-recipient", () => ({
  assertOwnershipRecipient: (...args: any[]) =>
    assertOwnershipRecipientMock(...args),
}));
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

function ownerOnlyProjectRow() {
  return projectRow({
    [OWNER_ID]: { group: "owner" },
  });
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
    assertOwnershipRecipientMock.mockReset().mockResolvedValue(undefined);
  });

  function mockLockedProject(overrides: Record<string, any> = {}) {
    clientQueryMock.mockImplementation(async (sql: string) => ({
      rows: sql.includes("FOR UPDATE")
        ? [
            {
              ...projectRow({
                [OWNER_ID]: { group: "owner", hide: true } as any,
                [COLLABORATOR_ID]: { group: "collaborator" },
              }),
              ...overrides,
            },
          ]
        : [],
    }));
  }

  const explicitOptions = {
    account_id: OWNER_ID,
    project_id: PROJECT_ID,
    from_account_id: OWNER_ID,
    to_account_id: COLLABORATOR_ID,
  };

  it("explicit transfer retains old owner metadata, refreshes both members, and audits the actor", async () => {
    mockLockedProject();
    const { transferProjectOwnershipExplicitly } = await import("./ownership");
    await transferProjectOwnershipExplicitly(explicitOptions);
    const update = clientQueryMock.mock.calls.find(([sql]) =>
      sql.includes("UPDATE projects"),
    );
    expect(JSON.parse(update![1][1])).toEqual({
      [OWNER_ID]: { group: "collaborator", hide: true },
      [COLLABORATOR_ID]: { group: "owner" },
    });
    expect(assertOwnershipRecipientMock).toHaveBeenCalledWith({
      account_id: COLLABORATOR_ID,
      project_id: PROJECT_ID,
      current_usage_account_id: OWNER_ID,
      resulting_usage_account_id: COLLABORATOR_ID,
    });
    expect(publishAccountFeedEventBestEffortMock).not.toHaveBeenCalled();
    expect(publishProjectAccountFeedEventsBestEffortMock).toHaveBeenCalled();
    expect(syncProjectUsersOnHostMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
    });
    const audit = clientQueryMock.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO central_log"),
    );
    expect(JSON.parse(audit![1][2])).toMatchObject({
      actor_account_id: OWNER_ID,
      from_account_id: OWNER_ID,
      to_account_id: COLLABORATOR_ID,
      old_owner_retained: true,
    });
    expect(clientQueryMock.mock.calls.at(-1)).toEqual(["COMMIT"]);
  });

  it("preserves independently assigned usage and runtime sponsors", async () => {
    mockLockedProject({
      usage_account_id: OTHER_COLLABORATOR_ID,
      runtime_sponsor_account_id: OTHER_COLLABORATOR_ID,
    });
    const { transferProjectOwnershipExplicitly } = await import("./ownership");
    await expect(
      transferProjectOwnershipExplicitly(explicitOptions),
    ).resolves.toMatchObject({
      usage_account_id: OTHER_COLLABORATOR_ID,
      runtime_sponsor_account_id: OTHER_COLLABORATOR_ID,
    });
  });

  it.each([
    { usage_account_id: COLLABORATOR_ID },
    {
      usage_account_id: null,
      course: { type: "student", account_id: OTHER_COLLABORATOR_ID },
    },
  ])("passes effective attribution to recipient preflight %j", async (row) => {
    mockLockedProject(row);
    const { transferProjectOwnershipExplicitly } = await import("./ownership");
    await transferProjectOwnershipExplicitly(explicitOptions);
    const payer = row.usage_account_id ?? row.course!.account_id;
    expect(assertOwnershipRecipientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        current_usage_account_id: payer,
        resulting_usage_account_id: payer,
      }),
    );
  });

  it("rolls back instead of silently losing the durable audit", async () => {
    mockLockedProject();
    const query = clientQueryMock.getMockImplementation()!;
    clientQueryMock.mockImplementation(async (sql: string, ...args: any[]) => {
      if (sql.includes("INSERT INTO central_log"))
        throw new Error("audit unavailable");
      return query(sql, ...args);
    });
    const { transferProjectOwnershipExplicitly } = await import("./ownership");
    await expect(
      transferProjectOwnershipExplicitly(explicitOptions),
    ).rejects.toThrow("audit unavailable");
    expect(clientQueryMock).toHaveBeenCalledWith("ROLLBACK");
    expect(clientQueryMock).not.toHaveBeenCalledWith("COMMIT");
    expect(
      publishProjectAccountFeedEventsBestEffortMock,
    ).not.toHaveBeenCalled();
  });

  it("rejects nonowners with 403 without opening a transaction", async () => {
    const { transferProjectOwnershipExplicitly } = await import("./ownership");
    await expect(
      transferProjectOwnershipExplicitly({
        ...explicitOptions,
        account_id: COLLABORATOR_ID,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(clientQueryMock).not.toHaveBeenCalled();
  });

  it("permits an explicitly trusted admin and records the real actor", async () => {
    mockLockedProject();
    const { transferProjectOwnershipExplicitly } = await import("./ownership");
    await transferProjectOwnershipExplicitly({
      ...explicitOptions,
      account_id: OTHER_COLLABORATOR_ID,
      trusted_admin: true,
    });
    const audit = clientQueryMock.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO central_log"),
    );
    expect(JSON.parse(audit![1][2])).toMatchObject({
      actor_account_id: OTHER_COLLABORATOR_ID,
      authorized_as_admin: true,
    });
  });

  it.each([
    [{ deleted: true }, "deleted project"],
    [{ owning_bay_id: "another-bay" }, "not owned by this bay"],
    [
      {
        users: {
          [OWNER_ID]: { group: "collaborator" },
          [COLLABORATOR_ID]: { group: "owner" },
        },
      },
      "current project owner",
    ],
    [
      { users: { [OWNER_ID]: { group: "owner" } } },
      "must be a project collaborator",
    ],
    [
      {
        users: {
          [OWNER_ID]: { group: "owner" },
          [COLLABORATOR_ID]: { group: "viewer" },
        },
      },
      "must be a project collaborator",
    ],
  ])("rejects invalid locked project state %j", async (row, message) => {
    mockLockedProject(row as Record<string, any>);
    const { transferProjectOwnershipExplicitly } = await import("./ownership");
    await expect(
      transferProjectOwnershipExplicitly(explicitOptions),
    ).rejects.toThrow(message as string);
    expect(
      clientQueryMock.mock.calls.some(([sql]) =>
        sql.includes("UPDATE projects"),
      ),
    ).toBe(false);
    expect(clientQueryMock).toHaveBeenCalledWith("ROLLBACK");
    expect(
      publishProjectAccountFeedEventsBestEffortMock,
    ).not.toHaveBeenCalled();
  });

  it("rolls back when recipient allowance or eligibility fails", async () => {
    mockLockedProject();
    assertOwnershipRecipientMock.mockRejectedValue(
      new Error("project limit reached"),
    );
    const { transferProjectOwnershipExplicitly } = await import("./ownership");
    await expect(
      transferProjectOwnershipExplicitly(explicitOptions),
    ).rejects.toThrow("project limit reached");
    expect(
      clientQueryMock.mock.calls.some(([sql]) =>
        sql.includes("UPDATE projects"),
      ),
    ).toBe(false);
    expect(appendProjectOutboxEventForProjectMock).not.toHaveBeenCalled();
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
      rows: [ownerOnlyProjectRow()],
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

  it("can hard-delete legacy soft-deleted owner-only project rows", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [ownerOnlyProjectRow()],
    });
    hardDeleteProjectMock.mockResolvedValueOnce({
      op_id: "55555555-5555-4555-8555-555555555555",
    });

    const { leaveOrDeleteProjectsForAccount } = await import("./ownership");
    await expect(
      leaveOrDeleteProjectsForAccount({
        account_id: OWNER_ID,
        project_ids: [PROJECT_ID],
        hardDeleteOwnedProject: async () => ({
          op_id: "55555555-5555-4555-8555-555555555555",
        }),
      }),
    ).resolves.toEqual([
      {
        project_id: PROJECT_ID,
        action: "hard_delete_queued",
        op_id: "55555555-5555-4555-8555-555555555555",
      },
    ]);

    const [sql] = poolQueryMock.mock.calls[0];
    expect(`${sql}`).not.toContain("deleted IS NOT TRUE");
    expect(hardDeleteProjectMock).not.toHaveBeenCalled();
  });
});
