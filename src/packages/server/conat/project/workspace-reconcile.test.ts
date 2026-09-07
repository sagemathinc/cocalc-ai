import {
  reconcileWorkspaceProjectStates,
  startWorkspaceProjectReconciliation,
} from "./workspace-reconcile";

const mockQuery = jest.fn();
const mockState = jest.fn();
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
  getProject: (id: string) => ({ state: () => mockState(id) }),
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
