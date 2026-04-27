import { act, render, screen } from "@testing-library/react";
import { useProjectWorkspaces } from "./state";
import { WORKSPACE_STORE_ROUTING_RETRY_DELAY_MS } from "./store";

const openProjectWorkspaceStore = jest.fn();
const isWorkspaceStoreRoutingPendingError = jest.fn();
const readWorkspaceRecordsFromStore = jest.fn();
const readWorkspaceOrderFromStore = jest.fn();
const hasWorkspaceStoreState = jest.fn();

jest.mock("./store", () => ({
  openProjectWorkspaceStore: (...args) => openProjectWorkspaceStore(...args),
  isWorkspaceStoreRoutingPendingError: (...args) =>
    isWorkspaceStoreRoutingPendingError(...args),
  WORKSPACE_STORE_ROUTING_RETRY_DELAY_MS: 250,
}));

jest.mock("./selection-runtime", () => ({
  loadSessionSelection: jest.fn(() => ({ kind: "all" })),
  loadSessionWorkspaceRecord: jest.fn(() => null),
  persistSessionSelection: jest.fn(),
  persistSessionWorkspaceRecord: jest.fn(),
  WORKSPACE_SELECTION_EVENT: "workspace-selection",
}));

jest.mock("./records-runtime", () => ({
  setRuntimeWorkspaceRecords: jest.fn(),
  clearRuntimeWorkspaceRecords: jest.fn(),
}));

jest.mock("@cocalc/conat/workspaces", () => {
  const actual = jest.requireActual("@cocalc/conat/workspaces");
  return {
    ...actual,
    readWorkspaceRecordsFromStore: (...args) =>
      readWorkspaceRecordsFromStore(...args),
    readWorkspaceOrderFromStore: (...args) =>
      readWorkspaceOrderFromStore(...args),
    hasWorkspaceStoreState: (...args) => hasWorkspaceStoreState(...args),
  };
});

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function record() {
  return {
    workspace_id: "ws-1",
    project_id: "00000000-0000-4000-8000-000000000111",
    root_path: "/home/user/project",
    theme: {
      title: "project",
      description: "",
      color: null,
      accent_color: null,
      icon: null,
      image_blob: null,
    },
    pinned: false,
    last_used_at: null,
    last_active_path: null,
    chat_path: null,
    notice_thread_id: null,
    notice: null,
    activity_viewed_at: null,
    activity_running_at: null,
    created_at: 1,
    updated_at: 1,
    source: "manual" as const,
  };
}

function Probe() {
  const state = useProjectWorkspaces(
    "account-1",
    "00000000-0000-4000-8000-000000000111",
  );
  return (
    <>
      <div data-testid="loading">{state.loading ? "yes" : "no"}</div>
      <div data-testid="count">{`${state.records.length}`}</div>
    </>
  );
}

describe("useProjectWorkspaces loading", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    isWorkspaceStoreRoutingPendingError.mockImplementation((err) =>
      `${err instanceof Error ? err.message : err}`.includes(
        "host routing info unavailable",
      ),
    );
    readWorkspaceRecordsFromStore.mockReturnValue([record()]);
    readWorkspaceOrderFromStore.mockReturnValue(["ws-1"]);
    hasWorkspaceStoreState.mockReturnValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps loading until the routed workspace store is available", async () => {
    const store = {
      on: jest.fn(),
      off: jest.fn(),
      close: jest.fn(),
    };
    openProjectWorkspaceStore
      .mockRejectedValueOnce(
        new Error(
          "unable to route 'useProjectWorkspaces' to project-host for project 00000000-0000-4000-8000-000000000111; host routing info unavailable",
        ),
      )
      .mockResolvedValueOnce(store);

    render(<Probe />);
    await flush();

    expect(screen.getByTestId("loading").textContent).toBe("yes");
    expect(openProjectWorkspaceStore).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(WORKSPACE_STORE_ROUTING_RETRY_DELAY_MS);
      await Promise.resolve();
    });
    await flush();

    expect(openProjectWorkspaceStore).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("loading").textContent).toBe("no");
    expect(screen.getByTestId("count").textContent).toBe("1");
  });
});
