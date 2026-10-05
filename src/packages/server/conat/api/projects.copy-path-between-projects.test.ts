export {};

let assertCollabMock: jest.Mock;
let createLroMock: jest.Mock;
let createLroDetailedMock: jest.Mock;
let getLroMock: jest.Mock;
let listCopiesByOpIdMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let publishLroEventMock: jest.Mock;
let triggerCopyLroWorkerMock: jest.Mock;
let triggerCourseCollectLroWorkerMock: jest.Mock;
let assertCanIncreaseAccountStorageMock: jest.Mock;
let resolveProjectAccessAllowRemoteMock: jest.Mock;
let assertCollabAllowRemoteProjectAccessMock: jest.Mock;
let ensureCourseManagerAccessLocalMock: jest.Mock;
let listCollaboratorsMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let resolveProjectBaysMock: jest.Mock;
let assertCollabBatchMock: jest.Mock;

const COURSE_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_OWNER_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";

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
  listCollaborators: (...args: any[]) => listCollaboratorsMock(...args),
}));

jest.mock("@cocalc/server/projects/course/ensure-manager-access", () => ({
  __esModule: true,
  ensureCourseManagerAccessLocal: (...args: any[]) =>
    ensureCourseManagerAccessLocalMock(...args),
}));

jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  __esModule: true,
  assertProjectCollaboratorAccessAllowRemoteBatch: (...args: any[]) =>
    assertCollabBatchMock(...args),
  resolveProjectAccessAllowRemote: (...args: any[]) =>
    resolveProjectAccessAllowRemoteMock(...args),
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

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
  resolveProjectBays: (...args: any[]) => resolveProjectBaysMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  __esModule: true,
  getConfiguredBayId: jest.fn(() => "local-bay"),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => {
    throw new Error("inter-bay bridge should not be used in this test");
  }),
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
  assertCanIncreaseAccountStorage: (...args: any[]) =>
    assertCanIncreaseAccountStorageMock(...args),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  createLro: (...args: any[]) => createLroMock(...args),
  createLroDetailed: (...args: any[]) => createLroDetailedMock(...args),
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
  assertCollabAllowRemoteProjectAccess: (...args: any[]) =>
    assertCollabAllowRemoteProjectAccessMock(...args),
}));

describe("projects.copyPathBetweenProjects", () => {
  beforeEach(() => {
    assertCollabMock = jest.fn(async () => undefined);
    createLroMock = jest.fn(async () => ({
      op_id: "op-1",
      scope_type: "project",
      scope_id: "src-project",
    }));
    createLroDetailedMock = jest.fn(async (...args) => ({
      lro: await createLroMock(...args),
      created: true,
    }));
    getLroMock = jest.fn(async () => undefined);
    listCopiesByOpIdMock = jest.fn(async () => []);
    publishLroSummaryMock = jest.fn(async () => undefined);
    publishLroEventMock = jest.fn(async () => undefined);
    triggerCopyLroWorkerMock = jest.fn();
    triggerCourseCollectLroWorkerMock = jest.fn();
    assertCanIncreaseAccountStorageMock = jest.fn(async () => undefined);
    resolveProjectAccessAllowRemoteMock = jest.fn(async () => ({
      role: "collaborator",
      capabilities: { writeProjectFiles: true },
    }));
    assertCollabAllowRemoteProjectAccessMock = jest.fn(
      async ({ project_id }) => ({
        project_id,
        users: { [OWNER_ACCOUNT_ID]: { group: "owner" } },
      }),
    );
    ensureCourseManagerAccessLocalMock = jest.fn(async ({ project_ids }) =>
      project_ids.map((project_id) => ({
        project_id,
        added_account_ids: [],
      })),
    );
    listCollaboratorsMock = jest.fn(async () => [
      { account_id: "acct-1", group: "collaborator" },
    ]);
    resolveProjectBayMock = jest.fn(async () => ({ bay_id: "local-bay" }));
    resolveProjectBaysMock = jest.fn(
      async (projectIds: string[]) =>
        new Map(
          projectIds.map((projectId) => [projectId, { bay_id: "local-bay" }]),
        ),
    );
    assertCollabBatchMock = jest.fn(async ({ project_ids }) =>
      project_ids.map((project_id) => ({
        project_id,
        users: { [OWNER_ACCOUNT_ID]: { group: "owner" } },
      })),
    );
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

  it("authorizes the source before queueing destination admission", async () => {
    const { copyPathBetweenProjects } = await import("./projects");
    await copyPathBetweenProjects({
      account_id: "acct-1",
      src: { project_id: "src-project", path: "/root/a.txt" },
      dest: { project_id: "dest-project", path: "/root/b.txt" },
    });

    expect(assertCollabMock).toHaveBeenCalledTimes(1);
    expect(resolveProjectAccessAllowRemoteMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: "src-project",
    });
    expect(assertCollabMock).toHaveBeenNthCalledWith(1, {
      account_id: "acct-1",
      project_id: "src-project",
    });
    expect(assertCollabAllowRemoteProjectAccessMock).not.toHaveBeenCalled();
  });

  it("checks collaboration once when source and destination project are the same", async () => {
    const { copyPathBetweenProjects } = await import("./projects");
    await copyPathBetweenProjects({
      account_id: "acct-1",
      src: { project_id: "src-project", path: "/root/a.txt" },
      dest: { project_id: "src-project", path: "/root/b.txt" },
    });
    expect(assertCollabMock).toHaveBeenCalledTimes(1);
    expect(assertCollabAllowRemoteProjectAccessMock).not.toHaveBeenCalled();
  });

  it("stores viewer policy while deferring destination admission", async () => {
    const readPolicy = { rules: [{ action: "include", path: "public/**" }] };
    resolveProjectAccessAllowRemoteMock = jest.fn(async () => ({
      role: "viewer",
      read_policy: readPolicy,
      capabilities: { writeProjectFiles: false },
    }));
    const { copyPathBetweenProjects } = await import("./projects");
    await copyPathBetweenProjects({
      account_id: "acct-1",
      src: { project_id: "src-project", path: "public/a.txt" },
      dest: { project_id: "dest-project", path: "copied/a.txt" },
    });

    expect(assertCollabMock).not.toHaveBeenCalled();
    expect(assertCollabAllowRemoteProjectAccessMock).not.toHaveBeenCalled();
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          src: { project_id: "src-project", path: "public/a.txt" },
          src_read_policy: readPolicy,
          dests: [{ project_id: "dest-project", path: "copied/a.txt" }],
        }),
      }),
    );
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
    expect(assertCanIncreaseAccountStorageMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      op_id: "op-1",
      scope_type: "project",
      scope_id: "src-project",
      service: "persist-service",
      stream_name: "stream:op-1",
    });
  });

  it("uses the request id to reuse a terminal copy operation", async () => {
    createLroDetailedMock = jest.fn(async () => ({
      lro: {
        op_id: "existing-op",
        scope_type: "project",
        scope_id: "src-project",
      },
      created: false,
    }));
    const { copyPathBetweenProjects } = await import("./projects");
    const result = await copyPathBetweenProjects({
      account_id: "acct-1",
      request_id: "55555555-5555-4555-8555-555555555555",
      src: { project_id: "src-project", path: "/root/a.txt" },
      dest: { project_id: "dest-project", path: "/root/b.txt" },
    });

    expect(createLroDetailedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupe_key:
          "copy-path-between-projects:acct-1:55555555-5555-4555-8555-555555555555",
        reuse_terminal_dedupe: true,
      }),
    );
    expect(publishLroSummaryMock).not.toHaveBeenCalled();
    expect(publishLroEventMock).not.toHaveBeenCalled();
    expect(triggerCopyLroWorkerMock).toHaveBeenCalledTimes(1);
    expect(result.op_id).toBe("existing-op");
  });

  it("rejects an invalid copy request id", async () => {
    const { copyPathBetweenProjects } = await import("./projects");
    await expect(
      copyPathBetweenProjects({
        account_id: "acct-1",
        request_id: "not-a-uuid",
        src: { project_id: "src-project", path: "/root/a.txt" },
        dest: { project_id: "dest-project", path: "/root/b.txt" },
      }),
    ).rejects.toThrow("request_id must be a valid uuid");
    expect(createLroDetailedMock).not.toHaveBeenCalled();
  });

  it("accepts multiple destinations and stores canonical dests in one LRO", async () => {
    assertCollabAllowRemoteProjectAccessMock = jest.fn(
      async ({ project_id }) => ({
        project_id,
        users: {
          [project_id === "dest-a"
            ? OWNER_ACCOUNT_ID
            : SECOND_OWNER_ACCOUNT_ID]: { group: "owner" },
        },
      }),
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

    expect(assertCollabMock).toHaveBeenCalledTimes(1);
    expect(assertCollabMock).toHaveBeenNthCalledWith(1, {
      account_id: "acct-1",
      project_id: "src-project",
    });
    expect(assertCollabAllowRemoteProjectAccessMock).not.toHaveBeenCalled();
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
    expect(assertCanIncreaseAccountStorageMock).not.toHaveBeenCalled();
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

    expect(assertCollabMock).toHaveBeenCalledTimes(1);
    expect(assertCollabAllowRemoteProjectAccessMock).not.toHaveBeenCalled();
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

  it("defers destination storage admission to the copy worker", async () => {
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
    ).resolves.toEqual(expect.objectContaining({ op_id: "op-1" }));
    expect(createLroMock).toHaveBeenCalledTimes(1);
    expect(assertCanIncreaseAccountStorageMock).not.toHaveBeenCalled();
    expect(triggerCopyLroWorkerMock).toHaveBeenCalledTimes(1);
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
      scope_id: COURSE_PROJECT_ID,
    }));
    const { collectAssignment } = await import("./projects");
    const result = await collectAssignment({
      account_id: "acct-1",
      course_project_id: COURSE_PROJECT_ID,
      assignment_id: "assignment-1",
      items: [
        {
          student_id: "student-1",
          student_project_id: STUDENT_PROJECT_ID,
          src_path: "Homework 1",
          dest_path: "course-collect/Homework 1/student-1",
          student_name: "Student One",
        },
      ],
      options: { recursive: true },
    });
    expect(assertCollabMock).toHaveBeenNthCalledWith(1, {
      account_id: "acct-1",
      project_id: COURSE_PROJECT_ID,
    });
    expect(assertCollabBatchMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_ids: [STUDENT_PROJECT_ID],
      warmRoute: false,
    });
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "course-collect-assignment",
        scope_type: "project",
        scope_id: COURSE_PROJECT_ID,
        created_by: "acct-1",
        routing: "hub",
        input: expect.objectContaining({
          course_project_id: COURSE_PROJECT_ID,
          assignment_id: "assignment-1",
          items: [
            {
              student_id: "student-1",
              student_project_id: STUDENT_PROJECT_ID,
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
      scope_id: COURSE_PROJECT_ID,
      service: "persist-service",
      stream_name: "stream:collect-op-1",
    });
  });

  it("stores scheduled course collection run time and dedupe key", async () => {
    const { collectAssignment } = await import("./projects");
    await collectAssignment({
      account_id: "acct-1",
      course_project_id: COURSE_PROJECT_ID,
      assignment_id: "assignment-1",
      run_at: "2026-05-14T17:00:00.000Z",
      items: [
        {
          student_id: "student-1",
          student_project_id: STUDENT_PROJECT_ID,
          src_path: "Homework 1",
          dest_path: "course-collect/Homework 1/student-1",
        },
      ],
    });

    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupe_key: `course-collect:${COURSE_PROJECT_ID}:assignment-1:2026-05-14T17:00:00.000Z`,
        input: expect.objectContaining({
          run_at: "2026-05-14T17:00:00.000Z",
        }),
      }),
    );
  });

  it.each([
    ["2026-10-20T04:59:00.000Z", "2026-10-27T04:59:00.000Z"],
    ["2026-09-20T04:59:00.000Z", "2026-10-08T12:00:00.000Z"],
    [undefined, undefined],
  ])("bounds collection expiry after run time %s", async (run_at, expiry) => {
    const now = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-10-01T12:00:00.000Z"));
    try {
      const { collectAssignment } = await import("./projects");
      await collectAssignment({
        account_id: "acct-1",
        course_project_id: COURSE_PROJECT_ID,
        assignment_id: "assignment-1",
        run_at,
        items: [
          {
            student_id: "student-1",
            student_project_id: STUDENT_PROJECT_ID,
            src_path: "Homework 1",
            dest_path: "course-collect/Homework 1/student-1",
          },
        ],
      });
      const input = createLroMock.mock.calls[0][0];
      if (expiry) {
        expect(input.expires_at).toEqual(new Date(expiry));
        expect(input.dedupe_key).toBe(
          `course-collect:${COURSE_PROJECT_ID}:assignment-1:${run_at}`,
        );
      } else {
        expect(input).not.toHaveProperty("expires_at");
        expect(input.dedupe_key).toBeUndefined();
      }
    } finally {
      now.mockRestore();
    }
  });

  it("creates a base-relative course assignment patch copy LRO", async () => {
    const { sendCourseAssignmentPatch } = await import("./projects");
    const result = await sendCourseAssignmentPatch({
      account_id: "acct-1",
      course_project_id: COURSE_PROJECT_ID,
      assignment_id: "assignment-1",
      src_base_path: "Homework 1/student",
      dest_base_path: "Homework 1",
      relative_paths: ["lesson.ipynb", "data/input.csv", "lesson.ipynb"],
      dests: [
        {
          student_id: "student-1",
          student_project_id: STUDENT_PROJECT_ID,
        },
      ],
    });

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: COURSE_PROJECT_ID,
    });
    expect(assertCollabBatchMock).not.toHaveBeenCalled();
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "copy-path-between-projects",
        scope_type: "project",
        scope_id: COURSE_PROJECT_ID,
        created_by: "acct-1",
        routing: "hub",
        input: {
          src: {
            project_id: COURSE_PROJECT_ID,
            base_path: "Homework 1/student",
            path: [
              "Homework 1/student/lesson.ipynb",
              "Homework 1/student/data/input.csv",
            ],
          },
          dests: [
            {
              project_id: STUDENT_PROJECT_ID,
              path: "Homework 1",
              metadata: {
                student_id: "student-1",
                course_item_id: "assignment-1",
              },
            },
          ],
          options: {
            recursive: true,
            force: false,
            errorOnExist: false,
          },
        },
        status: "queued",
      }),
    );
    expect(triggerCopyLroWorkerMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      op_id: "op-1",
      scope_type: "project",
      scope_id: COURSE_PROJECT_ID,
      service: "persist-service",
      stream_name: "stream:op-1",
    });
  });

  it("rejects course assignment patch paths that escape the assignment", async () => {
    const { sendCourseAssignmentPatch } = await import("./projects");
    await expect(
      sendCourseAssignmentPatch({
        account_id: "acct-1",
        course_project_id: COURSE_PROJECT_ID,
        assignment_id: "assignment-1",
        src_base_path: "Homework 1",
        dest_base_path: "Homework 1",
        relative_paths: ["../answers.txt"],
        dests: [
          {
            student_id: "student-1",
            student_project_id: STUDENT_PROJECT_ID,
          },
        ],
      }),
    ).rejects.toThrow("relative paths must stay inside the assignment");

    expect(createLroMock).not.toHaveBeenCalled();
  });
});
