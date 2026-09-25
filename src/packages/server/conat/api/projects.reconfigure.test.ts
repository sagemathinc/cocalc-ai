export {};

let assertCollabMock: jest.Mock;
let createLroDetailedMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let triggerWorkerMock: jest.Mock;
let poolQueryMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let resolveProjectBaysMock: jest.Mock;
let remoteReconfigureMock: jest.Mock;
let remoteGetOperationMock: jest.Mock;
let remoteCancelOperationMock: jest.Mock;
let previousInput: any;

jest.mock("@cocalc/server/projects/create", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/server/projects/collaborators", () => ({
  __esModule: true,
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => poolQueryMock(...args),
  })),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  createLro: jest.fn(),
  createLroDetailed: (...args: any[]) => createLroDetailedMock(...args),
  ensureLroSchema: jest.fn(async () => undefined),
  getLro: jest.fn(),
  updateLro: jest.fn(),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroEvent: jest.fn(),
  publishLroSummary: (...args: any[]) => publishLroSummaryMock(...args),
}));

jest.mock("@cocalc/server/projects/course-reconfigure-worker", () => ({
  __esModule: true,
  COURSE_RECONFIGURE_LRO_KIND: "course-reconfigure-projects",
  courseReconfigureLroResponse: (op: any) => ({
    op_id: op.op_id,
    scope_type: "project",
    scope_id: op.scope_id,
    service: "persist-service",
    stream_name: `stream:${op.op_id}`,
  }),
  triggerCourseReconfigureLroWorker: () => triggerWorkerMock(),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  __esModule: true,
  getConfiguredBayId: () => "bay-local",
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
  resolveProjectBays: (...args: any[]) => resolveProjectBaysMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: () => ({
    projectCollabInvite: () => ({
      reconfigureCourseProjects: (...args: any[]) =>
        remoteReconfigureMock(...args),
      getCourseReconfigureOperation: (...args: any[]) =>
        remoteGetOperationMock(...args),
      cancelCourseReconfigureOperation: (...args: any[]) =>
        remoteCancelOperationMock(...args),
    }),
  }),
}));

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: (...args: any[]) => assertCollabMock(...args),
  assertCollabAllowRemoteProjectAccess: (...args: any[]) =>
    assertCollabMock(...args),
}));

describe("course reconfiguration LRO admission", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const COURSE_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
  const STUDENT_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
  const SECOND_STUDENT_PROJECT_ID = "44444444-4444-4444-8444-444444444444";

  function request(project_id?: string) {
    return {
      account_id: ACCOUNT_ID,
      course_project_id: COURSE_PROJECT_ID,
      course_path: "/home/user/classes/main.course",
      settings: {
        title: "Linear Algebra",
        description: "Fall course",
        allow_collabs: false,
        datastore: true,
        invite: {
          subject: "Course invitation",
          message: "Please join",
          email_html: "<p>Please join</p>",
        },
      },
      students: [
        {
          student_id: "student-1",
          project_id,
          name: "Student One",
          email_address: "student@example.com",
        },
      ],
    };
  }

  beforeEach(() => {
    jest.resetModules();
    previousInput = undefined;
    assertCollabMock = jest.fn(async () => undefined);
    publishLroSummaryMock = jest.fn(async () => undefined);
    triggerWorkerMock = jest.fn();
    resolveProjectBayMock = jest.fn(async () => ({ bay_id: "bay-local" }));
    resolveProjectBaysMock = jest.fn(
      async (projectIds: string[]) =>
        new Map(
          projectIds.map((projectId) => [projectId, { bay_id: "bay-local" }]),
        ),
    );
    remoteReconfigureMock = jest.fn();
    remoteGetOperationMock = jest.fn();
    remoteCancelOperationMock = jest.fn(async () => undefined);
    poolQueryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT input")) {
        return { rows: previousInput ? [{ input: previousInput }] : [] };
      }
      if (sql.includes("status='succeeded'")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    createLroDetailedMock = jest.fn(async (opts: any) => ({
      created: true,
      lro: {
        op_id: "op-1",
        kind: opts.kind,
        scope_type: opts.scope_type,
        scope_id: opts.scope_id,
        status: "queued",
        input: opts.input,
      },
    }));
  });

  it("uses one stable active-operation key per course document", async () => {
    createLroDetailedMock = jest.fn(async (opts: any) => ({
      created: false,
      lro: {
        op_id: "active-op",
        kind: opts.kind,
        scope_type: opts.scope_type,
        scope_id: opts.scope_id,
        status: "running",
        input: { ...opts.input, snapshot_hash: "active-snapshot" },
      },
    }));
    const { reconfigureCourseProjects } = await import("./projects");
    const response = await reconfigureCourseProjects(
      request(STUDENT_PROJECT_ID),
    );

    expect(createLroDetailedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupe_key: "course-reconfigure:classes/main.course",
      }),
    );
    expect(response.op_id).toBe("active-op");
    expect(response.requested_snapshot_hash).not.toBe("active-snapshot");
    expect(response.operation_snapshot_hash).toBe("active-snapshot");
    expect(triggerWorkerMock).not.toHaveBeenCalled();
  });

  it("recovers assigned project ids without changing desired-state identity", async () => {
    const { reconfigureCourseProjects } = await import("./projects");
    await reconfigureCourseProjects(request());
    const firstInput = createLroDetailedMock.mock.calls[0][0].input;

    previousInput = firstInput;
    createLroDetailedMock.mockClear();
    await reconfigureCourseProjects(request());
    const recoveredInput = createLroDetailedMock.mock.calls[0][0].input;

    expect(recoveredInput.students[0]).toMatchObject({
      project_id: firstInput.students[0].project_id,
      create: false,
    });
    expect(firstInput.students[0].create).toBe(true);
    expect(recoveredInput.snapshot_hash).toBe(firstInput.snapshot_hash);
  });

  it("allocates a new project after an active student's recorded project was permanently deleted", async () => {
    resolveProjectBaysMock.mockResolvedValue(
      new Map([[STUDENT_PROJECT_ID, null]]),
    );
    const { reconfigureCourseProjects } = await import("./projects");

    await reconfigureCourseProjects(request(STUDENT_PROJECT_ID));
    const input = createLroDetailedMock.mock.calls[0][0].input;

    expect(input.students[0]).toMatchObject({
      student_id: "student-1",
      create: true,
    });
    expect(input.students[0].project_id).not.toBe(STUDENT_PROJECT_ID);
    expect(input.students[0].project_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("also replaces a deleted project id recovered from persisted operation state", async () => {
    previousInput = {
      students: [
        {
          student_id: "student-1",
          project_id: STUDENT_PROJECT_ID,
        },
      ],
    };
    resolveProjectBaysMock.mockResolvedValue(
      new Map([[STUDENT_PROJECT_ID, null]]),
    );
    const { reconfigureCourseProjects } = await import("./projects");

    await reconfigureCourseProjects(request());
    const student = createLroDetailedMock.mock.calls[0][0].input.students[0];

    expect(student).toMatchObject({ student_id: "student-1", create: true });
    expect(student.project_id).not.toBe(STUDENT_PROJECT_ID);
  });

  it("uses semantic snapshot identity across map and student ordering", async () => {
    const first: any = request(STUDENT_PROJECT_ID);
    first.settings.inherited_env = { ZED: "2", ALPHA: "1" };
    first.settings.datastore = ["z", "a"];
    first.students.push({
      student_id: "student-2",
      project_id: SECOND_STUDENT_PROJECT_ID,
      name: "Student Two",
      email_address: "two@example.com",
    });
    const second = {
      ...first,
      settings: {
        ...first.settings,
        inherited_env: { ALPHA: "1", ZED: "2" },
        datastore: ["a", "z"],
      },
      students: [...first.students].reverse(),
    };
    const { reconfigureCourseProjects } = await import("./projects");

    await reconfigureCourseProjects(first);
    const firstHash =
      createLroDetailedMock.mock.calls[0][0].input.snapshot_hash;
    createLroDetailedMock.mockClear();
    await reconfigureCourseProjects(second);
    const secondHash =
      createLroDetailedMock.mock.calls[0][0].input.snapshot_hash;

    expect(secondHash).toBe(firstHash);
  });

  it("coordinates the operation on the course project's owning bay", async () => {
    const remoteResult = {
      op_id: "remote-op",
      scope_type: "project",
      scope_id: COURSE_PROJECT_ID,
      service: "persist-service",
      stream_name: "stream:remote-op",
      requested_snapshot_hash: "requested",
      operation_snapshot_hash: "active",
    };
    resolveProjectBayMock.mockResolvedValue({ bay_id: "bay-remote" });
    remoteReconfigureMock.mockResolvedValue(remoteResult);
    const { reconfigureCourseProjects } = await import("./projects");

    await expect(
      reconfigureCourseProjects(request(STUDENT_PROJECT_ID)),
    ).resolves.toEqual(remoteResult);
    expect(remoteReconfigureMock).toHaveBeenCalledWith(
      request(STUDENT_PROJECT_ID),
    );
    expect(createLroDetailedMock).not.toHaveBeenCalled();
    expect(assertCollabMock).not.toHaveBeenCalled();
  });

  it("routes durable status and cancellation to the same owning bay", async () => {
    const summary = {
      op_id: "remote-op",
      kind: "course-reconfigure-projects",
      scope_type: "project",
      scope_id: COURSE_PROJECT_ID,
      status: "running",
    };
    resolveProjectBayMock.mockResolvedValue({ bay_id: "bay-remote" });
    remoteGetOperationMock.mockResolvedValue(summary);
    const { cancelCourseReconfigureOperation, getCourseReconfigureOperation } =
      await import("./projects");

    await expect(
      getCourseReconfigureOperation({
        account_id: ACCOUNT_ID,
        course_project_id: COURSE_PROJECT_ID,
        op_id: "remote-op",
      }),
    ).resolves.toEqual(summary);
    await expect(
      cancelCourseReconfigureOperation({
        account_id: ACCOUNT_ID,
        course_project_id: COURSE_PROJECT_ID,
        op_id: "remote-op",
      }),
    ).resolves.toBeUndefined();
    expect(remoteGetOperationMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      course_project_id: COURSE_PROJECT_ID,
      op_id: "remote-op",
    });
    expect(remoteCancelOperationMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      course_project_id: COURSE_PROJECT_ID,
      op_id: "remote-op",
    });
  });
});
