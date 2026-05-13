export {};

let assertCollabMock: jest.Mock;
let createLroMock: jest.Mock;
let getLroMock: jest.Mock;
let listCopiesByOpIdMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let publishLroEventMock: jest.Mock;
let triggerCopyLroWorkerMock: jest.Mock;
let triggerCourseCollectLroWorkerMock: jest.Mock;
let getProjectOwnerAccountIdMock: jest.Mock;
let assertCanIncreaseAccountStorageMock: jest.Mock;

jest.mock("@cocalc/server/projects/create", () => ({
  __esModule: true,
  default: jest.fn(),
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

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(async () => false),
}));

jest.mock("@cocalc/server/projects/collaborators", () => ({
  __esModule: true,
}));

jest.mock("@cocalc/conat/files/file-server", () => ({
  __esModule: true,
  client: jest.fn(),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: jest.fn() })),
}));

jest.mock("@cocalc/database", () => ({
  __esModule: true,
  db: jest.fn(() => ({})),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  updateAuthorizedKeysOnHost: jest.fn(),
}));

jest.mock("@cocalc/server/projects/control", () => ({
  __esModule: true,
  getProject: jest.fn(),
}));

jest.mock("@cocalc/server/projects/copy-db", () => ({
  __esModule: true,
  cancelCopy: jest.fn(),
  listCopiesByOpId: (...args: any[]) => listCopiesByOpIdMock(...args),
  listCopiesForProject: jest.fn(async () => []),
}));

jest.mock("@cocalc/server/projects/copy-worker", () => ({
  __esModule: true,
  triggerCopyLroWorker: (...args: any[]) => triggerCopyLroWorkerMock(...args),
}));

jest.mock("@cocalc/server/projects/course-collect-worker", () => ({
  __esModule: true,
  COURSE_COLLECT_ASSIGNMENT_LRO_KIND: "course-collect-assignment",
  triggerCourseCollectLroWorker: (...args: any[]) =>
    triggerCourseCollectLroWorkerMock(...args),
  courseCollectLroResponse: (op: any) => ({
    op_id: op.op_id,
    scope_type: "project",
    scope_id: op.scope_id,
    service: "persist-service",
    stream_name: `stream:${op.op_id}`,
  }),
}));

jest.mock("@cocalc/server/membership/project-limits", () => ({
  __esModule: true,
  getProjectOwnerAccountId: (...args: any[]) =>
    getProjectOwnerAccountIdMock(...args),
  assertCanIncreaseAccountStorage: (...args: any[]) =>
    assertCanIncreaseAccountStorageMock(...args),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  createLro: (...args: any[]) => createLroMock(...args),
  getLro: (...args: any[]) => getLroMock(...args),
  updateLro: jest.fn(),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroEvent: (...args: any[]) => publishLroEventMock(...args),
  publishLroSummary: (...args: any[]) => publishLroSummaryMock(...args),
}));

jest.mock("@cocalc/conat/lro/names", () => ({
  __esModule: true,
  lroStreamName: jest.fn((op_id: string) => `stream:${op_id}`),
}));

jest.mock("@cocalc/conat/persist/util", () => ({
  __esModule: true,
  SERVICE: "persist-service",
}));

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: (...args: any[]) => assertCollabMock(...args),
}));

describe("projects.copyPathBetweenProjects", () => {
  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    createLroMock = jest.fn(async () => ({
      op_id: "op-1",
      scope_type: "project",
      scope_id: "src-project",
    }));
    getLroMock = jest.fn(async () => undefined);
    listCopiesByOpIdMock = jest.fn(async () => []);
    publishLroSummaryMock = jest.fn(async () => undefined);
    publishLroEventMock = jest.fn(async () => undefined);
    triggerCopyLroWorkerMock = jest.fn();
    triggerCourseCollectLroWorkerMock = jest.fn();
    getProjectOwnerAccountIdMock = jest.fn(async () => "owner-1");
    assertCanIncreaseAccountStorageMock = jest.fn(async () => undefined);
  });

  it("requires a signed-in user", async () => {
    const { copyPathBetweenProjects } = await import("./projects");
    await expect(
      copyPathBetweenProjects({
        src: { project_id: "src-project", path: "/root/a.txt" },
        dest: { project_id: "dest-project", path: "/root/b.txt" },
      } as any),
    ).rejects.toThrow("user must be signed in");
    expect(assertCollabMock).not.toHaveBeenCalled();
  });

  it("checks collaboration on both projects when copying across projects", async () => {
    const { copyPathBetweenProjects } = await import("./projects");
    await copyPathBetweenProjects({
      account_id: "acct-1",
      src: { project_id: "src-project", path: "/root/a.txt" },
      dest: { project_id: "dest-project", path: "/root/b.txt" },
    });

    expect(assertCollabMock).toHaveBeenCalledTimes(2);
    expect(assertCollabMock).toHaveBeenNthCalledWith(1, {
      account_id: "acct-1",
      project_id: "src-project",
    });
    expect(assertCollabMock).toHaveBeenNthCalledWith(2, {
      account_id: "acct-1",
      project_id: "dest-project",
    });
  });

  it("checks collaboration once when source and destination project are the same", async () => {
    const { copyPathBetweenProjects } = await import("./projects");
    await copyPathBetweenProjects({
      account_id: "acct-1",
      src: { project_id: "src-project", path: "/root/a.txt" },
      dest: { project_id: "src-project", path: "/root/b.txt" },
    });
    expect(assertCollabMock).toHaveBeenCalledTimes(1);
  });

  it("creates and publishes an LRO and returns stream metadata", async () => {
    const { copyPathBetweenProjects } = await import("./projects");
    const result = await copyPathBetweenProjects({
      account_id: "acct-1",
      src: { project_id: "src-project", path: ["/root/a.txt", "/tmp/b.txt"] },
      dest: { project_id: "dest-project", path: "/root/out" },
      options: { force: true },
    });

    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "copy-path-between-projects",
        scope_type: "project",
        scope_id: "src-project",
        created_by: "acct-1",
        routing: "hub",
        input: {
          src: {
            project_id: "src-project",
            path: ["/root/a.txt", "/tmp/b.txt"],
          },
          dests: [{ project_id: "dest-project", path: "/root/out" }],
          options: { force: true },
        },
        status: "queued",
      }),
    );
    expect(publishLroSummaryMock).toHaveBeenCalledTimes(1);
    expect(publishLroEventMock).toHaveBeenCalledTimes(1);
    expect(triggerCopyLroWorkerMock).toHaveBeenCalledTimes(1);
    expect(getProjectOwnerAccountIdMock).toHaveBeenCalledWith("dest-project");
    expect(assertCanIncreaseAccountStorageMock).toHaveBeenCalledWith({
      account_id: "owner-1",
    });
    expect(result).toEqual({
      op_id: "op-1",
      scope_type: "project",
      scope_id: "src-project",
      service: "persist-service",
      stream_name: "stream:op-1",
    });
  });

  it("accepts multiple destinations and stores canonical dests in one LRO", async () => {
    getProjectOwnerAccountIdMock = jest.fn(async (project_id: string) =>
      project_id === "dest-a" ? "owner-a" : "owner-b",
    );
    const { copyPathBetweenProjects } = await import("./projects");
    await copyPathBetweenProjects({
      account_id: "acct-1",
      src: { project_id: "src-project", path: "/root/assignment" },
      dests: [
        {
          project_id: "dest-a",
          path: "/root/assignment",
          metadata: { student_id: "student-a" },
        },
        {
          project_id: "dest-b",
          path: "/root/assignment",
          metadata: { student_id: "student-b" },
        },
      ],
      options: { recursive: true, force: true },
    });

    expect(assertCollabMock).toHaveBeenCalledTimes(3);
    expect(assertCollabMock).toHaveBeenNthCalledWith(1, {
      account_id: "acct-1",
      project_id: "src-project",
    });
    expect(assertCollabMock).toHaveBeenNthCalledWith(2, {
      account_id: "acct-1",
      project_id: "dest-a",
    });
    expect(assertCollabMock).toHaveBeenNthCalledWith(3, {
      account_id: "acct-1",
      project_id: "dest-b",
    });
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          src: { project_id: "src-project", path: "/root/assignment" },
          dests: [
            {
              project_id: "dest-a",
              path: "/root/assignment",
              metadata: { student_id: "student-a" },
            },
            {
              project_id: "dest-b",
              path: "/root/assignment",
              metadata: { student_id: "student-b" },
            },
          ],
          options: { recursive: true, force: true },
        },
      }),
    );
    expect(getProjectOwnerAccountIdMock).toHaveBeenCalledTimes(2);
    expect(assertCanIncreaseAccountStorageMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates repeated destinations before authorization and LRO creation", async () => {
    const { copyPathBetweenProjects } = await import("./projects");
    await copyPathBetweenProjects({
      account_id: "acct-1",
      src: { project_id: "src-project", path: "/root/assignment" },
      dests: [
        { project_id: "dest-project", path: "/root/assignment" },
        { project_id: "dest-project", path: "/root/assignment" },
      ],
    });

    expect(assertCollabMock).toHaveBeenCalledTimes(2);
    expect(getProjectOwnerAccountIdMock).toHaveBeenCalledTimes(1);
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          src: { project_id: "src-project", path: "/root/assignment" },
          dests: [{ project_id: "dest-project", path: "/root/assignment" }],
          options: undefined,
        },
      }),
    );
  });

  it("rejects ambiguous or empty destination input", async () => {
    const { copyPathBetweenProjects } = await import("./projects");
    await expect(
      copyPathBetweenProjects({
        account_id: "acct-1",
        src: { project_id: "src-project", path: "/root/a.txt" },
        dest: { project_id: "dest-project", path: "/root/a.txt" },
        dests: [{ project_id: "dest-project", path: "/root/b.txt" }],
      }),
    ).rejects.toThrow("specify exactly one of dest or dests");
    await expect(
      copyPathBetweenProjects({
        account_id: "acct-1",
        src: { project_id: "src-project", path: "/root/a.txt" },
        dests: [],
      }),
    ).rejects.toThrow("at least one destination is required");
    expect(createLroMock).not.toHaveBeenCalled();
  });

  it("blocks copy when the destination owner is already at the hard storage cap", async () => {
    assertCanIncreaseAccountStorageMock = jest.fn(async () => {
      throw new Error("total account storage hard cap reached");
    });
    const { copyPathBetweenProjects } = await import("./projects");
    await expect(
      copyPathBetweenProjects({
        account_id: "acct-1",
        src: { project_id: "src-project", path: "/root/a.txt" },
        dest: { project_id: "dest-project", path: "/root/b.txt" },
      }),
    ).rejects.toThrow("total account storage hard cap reached");
    expect(createLroMock).not.toHaveBeenCalled();
    expect(triggerCopyLroWorkerMock).not.toHaveBeenCalled();
  });

  it("lists copy rows by op id after checking source project access", async () => {
    getLroMock = jest.fn(async () => ({
      op_id: "op-1",
      kind: "copy-path-between-projects",
      scope_type: "project",
      scope_id: "src-project",
    }));
    listCopiesByOpIdMock = jest.fn(async () => [
      {
        copy_id: "copy-1",
        op_id: "op-1",
        src_project_id: "src-project",
        dest_project_id: "dest-project",
      },
    ]);
    const { listCopyRowsByOpId } = await import("./projects");
    const rows = await listCopyRowsByOpId({
      account_id: "acct-1",
      op_id: "op-1",
    });
    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: "src-project",
    });
    expect(listCopiesByOpIdMock).toHaveBeenCalledWith({ op_id: "op-1" });
    expect(rows).toEqual([
      expect.objectContaining({
        copy_id: "copy-1",
        op_id: "op-1",
      }),
    ]);
  });

  it("rejects copy row listing for non-copy operations", async () => {
    getLroMock = jest.fn(async () => ({
      op_id: "op-1",
      kind: "project-start",
      scope_type: "project",
      scope_id: "src-project",
    }));
    const { listCopyRowsByOpId } = await import("./projects");
    await expect(
      listCopyRowsByOpId({ account_id: "acct-1", op_id: "op-1" }),
    ).rejects.toThrow("operation is not a project copy");
    expect(listCopiesByOpIdMock).not.toHaveBeenCalled();
  });

  it("creates a course collection LRO after checking course and student project access", async () => {
    createLroMock = jest.fn(async () => ({
      op_id: "collect-op-1",
      scope_type: "project",
      scope_id: "course-project",
    }));
    const { collectAssignment } = await import("./projects");
    const result = await collectAssignment({
      account_id: "acct-1",
      course_project_id: "course-project",
      assignment_id: "assignment-1",
      items: [
        {
          student_id: "student-1",
          student_project_id: "student-project-1",
          src_path: "Homework 1",
          dest_path: "course-collect/Homework 1/student-1",
          student_name: "Student One",
        },
      ],
      options: { recursive: true },
    });
    expect(assertCollabMock).toHaveBeenNthCalledWith(1, {
      account_id: "acct-1",
      project_id: "course-project",
    });
    expect(assertCollabMock).toHaveBeenNthCalledWith(2, {
      account_id: "acct-1",
      project_id: "student-project-1",
    });
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "course-collect-assignment",
        scope_type: "project",
        scope_id: "course-project",
        created_by: "acct-1",
        routing: "hub",
        input: expect.objectContaining({
          course_project_id: "course-project",
          assignment_id: "assignment-1",
          items: [
            {
              student_id: "student-1",
              student_project_id: "student-project-1",
              src_path: "Homework 1",
              dest_path: "course-collect/Homework 1/student-1",
              student_name: "Student One",
            },
          ],
          options: { recursive: true },
        }),
        status: "queued",
      }),
    );
    expect(triggerCourseCollectLroWorkerMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      op_id: "collect-op-1",
      scope_type: "project",
      scope_id: "course-project",
      service: "persist-service",
      stream_name: "stream:collect-op-1",
    });
  });

  it("stores scheduled course collection run time and dedupe key", async () => {
    const { collectAssignment } = await import("./projects");
    await collectAssignment({
      account_id: "acct-1",
      course_project_id: "course-project",
      assignment_id: "assignment-1",
      run_at: "2026-05-14T17:00:00.000Z",
      items: [
        {
          student_id: "student-1",
          student_project_id: "student-project-1",
          src_path: "Homework 1",
          dest_path: "course-collect/Homework 1/student-1",
        },
      ],
    });

    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupe_key:
          "course-collect:course-project:assignment-1:2026-05-14T17:00:00.000Z",
        input: expect.objectContaining({
          run_at: "2026-05-14T17:00:00.000Z",
        }),
      }),
    );
  });
});
