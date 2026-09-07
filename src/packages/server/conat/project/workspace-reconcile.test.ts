import {
  reconcileWorkspaceProjectStates,
  startWorkspaceProjectReconciliation,
  saveWorkspaceProjectState,
} from "./workspace-reconcile";

const mockQuery = jest.fn();
const mockState = jest.fn();
const mockSave = jest.fn();
let mockWorkspace = true;
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "local-bay",
}));
jest.mock("@cocalc/server/launchpad/project-runtime", () => ({
  isWorkspaceProjectRuntime: () => mockWorkspace,
}));
jest.mock("@cocalc/server/projects/control", () => ({
  getProject: (id: string) => ({
    state: () => mockState(id),
    saveStateToDatabase: mockSave,
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockWorkspace = true;
  mockQuery.mockResolvedValue({
    rows: [{ project_id: "missing-record" }, { project_id: "live-record" }],
  });
  mockState.mockResolvedValue({ state: "opened" });
});
afterEach(() => jest.useRealTimers());

it("does not republish unchanged workspace states or refresh their timestamps", async () => {
  mockQuery.mockResolvedValue({ rows: [{ state: "running" }] });
  await saveWorkspaceProjectState("live-record", "running");
  await saveWorkspaceProjectState("live-record", "running");
  expect(mockSave).not.toHaveBeenCalled();
});

it("persists an observed transition using the existing projection-aware writer", async () => {
  mockQuery.mockResolvedValue({ rows: [{ state: "running" }] });
  await saveWorkspaceProjectState("missing-record", "opened");
  expect(mockSave).toHaveBeenCalledWith({ state: "opened" });
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("COALESCE(owning_bay_id, $2)=$2"),
    ["missing-record", "local-bay"],
  );
});

it("does not save projects outside the local workspace scope", async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  await saveWorkspaceProjectState("not-local", "opened");
  expect(mockSave).not.toHaveBeenCalled();
});

it("checks database running projects even with no runtime record, scoped to this bay and no host", async () => {
  await reconcileWorkspaceProjectStates();
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("COALESCE(owning_bay_id, $1)=$1"),
    ["local-bay"],
  );
  expect(mockQuery.mock.calls[0][0]).toContain("host_id IS NULL");
  expect(mockQuery.mock.calls[0][0]).toContain("state->>'state'='running'");
  expect(mockState.mock.calls).toEqual([["missing-record"], ["live-record"]]);
});

it("does not reconcile VM-backed runtimes", async () => {
  mockWorkspace = false;
  await reconcileWorkspaceProjectStates();
  const stop = startWorkspaceProjectReconciliation();
  stop();
  expect(mockQuery).not.toHaveBeenCalled();
});

it("continues past a failed project probe", async () => {
  mockState.mockRejectedValueOnce(new Error("runner unavailable"));
  await reconcileWorkspaceProjectStates();
  expect(mockState).toHaveBeenCalledTimes(2);
});

it("runs at startup, repeats without overlapping, and stops on shutdown", async () => {
  jest.useFakeTimers();
  let finish!: () => void;
  mockQuery.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ rows: [] });
      }),
  );
  const stop = startWorkspaceProjectReconciliation();
  await jest.advanceTimersByTimeAsync(30_000);
  expect(mockQuery).toHaveBeenCalledTimes(1);
  finish();
  await jest.advanceTimersByTimeAsync(10_000);
  expect(mockQuery).toHaveBeenCalledTimes(2);
  stop();
  await jest.advanceTimersByTimeAsync(30_000);
  expect(mockQuery).toHaveBeenCalledTimes(2);
});
