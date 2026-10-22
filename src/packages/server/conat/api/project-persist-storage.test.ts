const assertCollab = jest.fn();
const assertCanPerformDestructiveStorageAction = jest.fn();
const requireDangerousProjectMutationAuth = jest.fn();
const persistStorageList = jest.fn();
const persistStorageApply = jest.fn();
const getProjectFileServerClient = jest.fn(async () => ({
  persistStorageList,
  persistStorageApply,
}));

jest.mock("./util", () => ({
  assertCollab: (...args: any[]) => assertCollab(...args),
}));
jest.mock("@cocalc/server/projects/destructive-storage-actions", () => ({
  assertCanPerformDestructiveStorageAction: (...args: any[]) =>
    assertCanPerformDestructiveStorageAction(...args),
}));
jest.mock("./project-dangerous-auth", () => ({
  requireDangerousProjectMutationAuth: (...args: any[]) =>
    requireDangerousProjectMutationAuth(...args),
}));
jest.mock("@cocalc/server/conat/file-server-client", () => ({
  getProjectFileServerClient: (...args: any[]) =>
    getProjectFileServerClient(...(args as [])),
}));

import {
  applyProjectPersistStorage,
  listProjectPersistStorage,
} from "./project-persist-storage";

const account_id = "00000000-1111-4222-8333-444444444444";
const project_id = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  jest.clearAllMocks();
  persistStorageList.mockResolvedValue({
    supported: true,
    streams: [],
    total: { count: 0, bytes: 0 },
    by_kind: {},
  });
  persistStorageApply.mockResolvedValue({ results: [], freed: 0 });
});

describe("listProjectPersistStorage", () => {
  it("is for collaborators, and says whether they may manage it", async () => {
    const list = await listProjectPersistStorage({
      account_id,
      project_id,
      limit: 10,
    });
    expect(assertCollab).toHaveBeenCalledWith({ account_id, project_id });
    expect(persistStorageList).toHaveBeenCalledWith({ project_id, limit: 10 });
    expect(list.can_manage).toBe(true);
    assertCanPerformDestructiveStorageAction.mockRejectedValueOnce(
      new Error("Only project owners can ..."),
    );
    expect(
      (await listProjectPersistStorage({ account_id, project_id })).can_manage,
    ).toBe(false);
  });

  it("refuses non-collaborators", async () => {
    assertCollab.mockRejectedValueOnce(new Error("not a collaborator"));
    await expect(
      listProjectPersistStorage({ account_id, project_id }),
    ).rejects.toThrow("not a collaborator");
    expect(persistStorageList).not.toHaveBeenCalled();
  });
});

describe("applyProjectPersistStorage", () => {
  it("needs a fresh sign-in and the right to destroy recovery history", async () => {
    const actions = [
      { op: "delete" as const, name: "patchflow/home/user/a.md" },
      {
        op: "trim" as const,
        name: "acp-log/home/user/a.chat",
        before: 1000,
        extra: "dropped",
      } as any,
    ];
    await applyProjectPersistStorage({
      account_id,
      browser_id: "b",
      project_id,
      actions,
    });
    expect(requireDangerousProjectMutationAuth).toHaveBeenCalledWith({
      account_id,
      browser_id: "b",
      session_hash: undefined,
    });
    expect(assertCanPerformDestructiveStorageAction).toHaveBeenCalledWith({
      account_id,
      project_id,
      action: "delete or trim edit history and logs",
    });
    expect(persistStorageApply).toHaveBeenCalledWith({
      project_id,
      actions: [
        { op: "delete", name: "patchflow/home/user/a.md" },
        { op: "trim", name: "acp-log/home/user/a.chat", before: 1000 },
      ],
    });
  });

  it("does nothing for someone who may not", async () => {
    assertCanPerformDestructiveStorageAction.mockRejectedValueOnce(
      new Error("Only project owners can delete or trim edit history and logs"),
    );
    await expect(
      applyProjectPersistStorage({
        account_id,
        project_id,
        actions: [{ op: "delete", name: "x" }],
      }),
    ).rejects.toThrow(/Only project owners/);
    expect(persistStorageApply).not.toHaveBeenCalled();
  });

  it("refuses malformed actions before anything else", async () => {
    for (const actions of [
      "x",
      [{ op: "rm", name: "x" }],
      [{ op: "delete" }],
      [{ op: "trim", name: "x", before: "soon" }],
      Array.from({ length: 1001 }, () => ({ op: "delete", name: "x" })),
    ]) {
      await expect(
        applyProjectPersistStorage({
          account_id,
          project_id,
          actions: actions as any,
        }),
      ).rejects.toThrow();
    }
    expect(requireDangerousProjectMutationAuth).not.toHaveBeenCalled();
    expect(persistStorageApply).not.toHaveBeenCalled();
  });
});
