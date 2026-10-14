import { Map as ImmutableMap } from "immutable";

import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { MAX_BULK_PROJECT_CONTROL } from "@cocalc/conat/hub/api/projects";
import { ProjectsActions } from "./actions";

const mockProjectState = { value: "running" };

jest.mock("./store", () => ({
  store: {
    get: jest.fn(() => ImmutableMap()),
    // Each project is in mockProjectState, and not being deleted.
    getIn: jest.fn((path: string[]) =>
      path.length > 2 ? mockProjectState.value : undefined,
    ),
    get_state: jest.fn(),
    async_wait: jest.fn(),
    classify_project: jest.fn(() => ({})),
  },
}));

jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/frontend/projection-ack", () => ({
  writeAndWaitForProjection: jest.fn(async ({ write }) => await write()),
  isProjectionConvergenceError: jest.fn(() => false),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: "acct-1",
    server_time: jest.fn(() => new Date()),
    conat_client: {
      hub: {
        projects: {
          stopProjects: jest.fn(),
          restartProjects: jest.fn(),
          restart: jest.fn(),
        },
      },
    },
  },
}));

const hub = (webapp_client as any).conat_client.hub.projects;

function ids(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `00000000-0000-4000-8000-${`${i}`.padStart(12, "0")}`,
  );
}

describe("bulk stop and restart", () => {
  let projectActions: Record<string, any>;
  let actions: any;

  beforeEach(() => {
    jest.clearAllMocks();
    projectActions = {};
    jest.spyOn(redux, "getProjectActions").mockImplementation(
      (project_id: string) =>
        (projectActions[project_id] ??= {
          setState: jest.fn(),
          trackStartOp: jest.fn(),
        }) as any,
    );
    actions = new ProjectsActions("projects", redux as any) as any;
    actions.project_log = jest.fn(async () => undefined);
    actions.optimisticProjectStateUpdate = jest.fn();
    actions.scheduleProjectedProjectReconcile = jest.fn();
    actions.scheduleProjectLifecycleReconcile = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stops in one call per MAX_BULK_PROJECT_CONTROL projects, with a long timeout", async () => {
    const project_ids = ids(MAX_BULK_PROJECT_CONTROL + 1);
    hub.stopProjects.mockImplementation(async ({ project_ids }) =>
      project_ids.map((project_id) => ({ project_id, ok: true })),
    );
    const results = await actions.stop_projects(project_ids);
    expect(results).toHaveLength(project_ids.length);
    expect(hub.stopProjects).toHaveBeenCalledTimes(2);
    const [first, second] = hub.stopProjects.mock.calls.map(([opts]) => opts);
    expect(first.project_ids).toEqual(
      project_ids.slice(0, MAX_BULK_PROJECT_CONTROL),
    );
    expect(second.project_ids).toEqual([project_ids.at(-1)]);
    // Far longer than the default 15 s hub call timeout.
    expect(first.timeout).toBeGreaterThan(60_000);
    expect(actions.optimisticProjectStateUpdate).toHaveBeenCalledWith(
      project_ids[0],
      "opened",
    );
  });

  it("shows each project's failure on that project, and a failed call on all of its projects", async () => {
    const project_ids = ids(MAX_BULK_PROJECT_CONTROL + 2);
    hub.stopProjects
      .mockImplementationOnce(async ({ project_ids }) =>
        project_ids.map((project_id, i) =>
          i === 0
            ? { project_id, ok: false, error: "host is unreachable" }
            : { project_id, ok: true },
        ),
      )
      .mockRejectedValueOnce(new Error("timeout"));
    const results = await actions.stop_projects(project_ids);
    expect(results.filter((r) => !r.ok).map((r) => r.project_id)).toEqual([
      project_ids[0],
      ...project_ids.slice(MAX_BULK_PROJECT_CONTROL),
    ]);
    expect(projectActions[project_ids[0]].setState).toHaveBeenCalledWith({
      control_error: "Error stopping project -- host is unreachable",
    });
    expect(projectActions[project_ids.at(-1)!].setState).toHaveBeenCalledWith({
      control_error: "Error stopping project -- Error: timeout",
    });
    expect(actions.optimisticProjectStateUpdate).not.toHaveBeenCalledWith(
      project_ids[0],
      "opened",
    );
  });

  it("restarts with one request id, tracks each operation and restores failures", async () => {
    const project_ids = ids(2);
    hub.restartProjects.mockResolvedValue([
      { project_id: project_ids[0], ok: true, op_id: "op-0" },
      { project_id: project_ids[1], ok: false, error: "no host" },
    ]);
    await actions.restart_projects(project_ids);
    const [opts] = hub.restartProjects.mock.calls[0];
    expect(opts.project_ids).toEqual(project_ids);
    expect(opts.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(projectActions[project_ids[0]].trackStartOp).toHaveBeenCalledWith({
      op_id: "op-0",
      scope_type: "project",
      scope_id: project_ids[0],
    });
    expect(actions.optimisticProjectStateUpdate).toHaveBeenCalledWith(
      project_ids[1],
      "running",
    );
    expect(projectActions[project_ids[1]].setState).toHaveBeenCalledWith({
      control_error: "Error restarting project -- no host",
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("overlapping restarts of a project", () => {
  const project_id = ids(1)[0];
  let projectActions: any;
  let actions: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProjectState.value = "running";
    projectActions = { setState: jest.fn(), trackStartOp: jest.fn() };
    jest
      .spyOn(redux, "getProjectActions")
      .mockImplementation(() => projectActions);
    actions = new ProjectsActions("projects", redux as any) as any;
    actions.project_log = jest.fn(async () => undefined);
    actions.optimisticProjectStateUpdate = jest.fn();
    actions.scheduleProjectLifecycleReconcile = jest.fn();
    actions.projectedProjectStateMatches = jest.fn(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const errors = () =>
    projectActions.setState.mock.calls
      .map(([state]) => state)
      .filter((state) => "control_error" in state)
      .map((state) => state.control_error);

  it("shows the restart as requested, as a single restart does", async () => {
    hub.restartProjects.mockResolvedValue([
      { project_id, ok: true, op_id: "op-1" },
    ]);
    await actions.restart_projects([project_id]);
    const [{ restart_request }] = projectActions.setState.mock.calls.find(
      ([state]) => state.restart_request,
    );
    expect(restart_request.get("token")).toMatch(/^[0-9a-f-]{36}$/);
    expect(actions.optimisticProjectStateUpdate).toHaveBeenCalledWith(
      project_id,
      "starting",
    );
  });

  it("bulk then bulk: an older bulk restart finishing last changes nothing", async () => {
    const older = deferred<any>();
    hub.restartProjects
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce([{ project_id, ok: false, error: "boom" }]);
    const first = actions.restart_projects([project_id]);
    await actions.restart_projects([project_id]);
    expect(errors()).toEqual(["Error restarting project -- boom"]);
    older.resolve([{ project_id, ok: true, op_id: "older-op" }]);
    await first;
    expect(projectActions.trackStartOp).not.toHaveBeenCalled();
    expect(errors()).toEqual(["Error restarting project -- boom"]);
  });

  it("bulk then single: the older bulk failure does not undo the newer restart", async () => {
    const older = deferred<any>();
    hub.restartProjects.mockReturnValueOnce(older.promise);
    hub.restart.mockResolvedValueOnce({
      op_id: "single-op",
      scope_type: "project",
      scope_id: project_id,
    });
    const first = actions.restart_projects([project_id]);
    await actions.restart_project(project_id);
    expect(projectActions.trackStartOp).toHaveBeenCalledWith(
      expect.objectContaining({ op_id: "single-op" }),
    );
    actions.optimisticProjectStateUpdate.mockClear();
    older.resolve([{ project_id, ok: false, error: "late failure" }]);
    await first;
    expect(errors()).not.toContain("Error restarting project -- late failure");
    expect(actions.optimisticProjectStateUpdate).not.toHaveBeenCalled();
  });

  it("single then bulk: the older single restart finishing last is not tracked", async () => {
    const older = deferred<any>();
    hub.restart.mockReturnValueOnce(older.promise);
    hub.restartProjects.mockResolvedValueOnce([
      { project_id, ok: true, op_id: "bulk-op" },
    ]);
    const first = actions.restart_project(project_id);
    await actions.restart_projects([project_id]);
    older.resolve({
      op_id: "single-op",
      scope_type: "project",
      scope_id: project_id,
    });
    await first;
    expect(
      projectActions.trackStartOp.mock.calls.map(([op]) => op.op_id),
    ).toEqual(["bulk-op"]);
  });

  it("restores the state from before the first of overlapping restarts", async () => {
    const older = deferred<any>();
    hub.restartProjects
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce([{ project_id, ok: false, error: "boom" }]);
    const first = actions.restart_projects([project_id]);
    // Once the first restart has been sent, the second one sees its
    // optimistic state.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hub.restartProjects).toHaveBeenCalledTimes(1);
    mockProjectState.value = "starting";
    await actions.restart_projects([project_id]);
    // "running" from before the first restart, not its optimistic "starting".
    expect(actions.optimisticProjectStateUpdate).toHaveBeenLastCalledWith(
      project_id,
      "running",
    );
    older.resolve([]);
    await first;
  });
});
