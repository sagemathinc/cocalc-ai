export {};

let assertLocalProjectCollaboratorMock: jest.Mock;
let queryMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  assertLocalProjectCollaborator: (...args: any[]) =>
    assertLocalProjectCollaboratorMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
  getTransactionClient: jest.fn(),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe("studentPayTransfer local bay access", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
  const PAID_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    queryMock = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [{ course: { project_id: "course-a" } }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            course: {
              project_id: "course-b",
              paid: "2026-04-03T00:00:00.000Z",
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });
  });

  it("rejects transfers when the target project belongs to another bay", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("project belongs to another bay");
    });
    const { studentPayTransfer } = await import("./student-pay");
    await expect(
      studentPayTransfer({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        paid_project_id: PAID_PROJECT_ID,
      }),
    ).rejects.toThrow("project belongs to another bay");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("updates payment transfer when both projects are local", async () => {
    const { studentPayTransfer } = await import("./student-pay");
    await expect(
      studentPayTransfer({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        paid_project_id: PAID_PROJECT_ID,
      }),
    ).resolves.toBeUndefined();
    expect(assertLocalProjectCollaboratorMock).toHaveBeenNthCalledWith(1, {
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(assertLocalProjectCollaboratorMock).toHaveBeenNthCalledWith(2, {
      account_id: ACCOUNT_ID,
      project_id: PAID_PROJECT_ID,
    });
    expect(queryMock).toHaveBeenNthCalledWith(
      3,
      "UPDATE projects SET course=jsonb_set(course, '{paid}', to_jsonb(NOW()::text)) WHERE project_id=$1",
      [PROJECT_ID],
    );
    expect(queryMock).toHaveBeenNthCalledWith(
      4,
      "UPDATE projects SET course=course#-'{paid}' WHERE project_id=$1",
      [PAID_PROJECT_ID],
    );
  });
});
