import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GpuCostDashboard } from "./cost-dashboard";
import type {
  DashboardPod,
  GpuCostDashboardApi,
  GpuDashboardScope,
  GpuSpendResult,
} from "./types";

const mockFreshAuth = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: (action) => mockFreshAuth(action),
    freshAuthModalProps: {},
  }),
}));

beforeEach(() => {
  mockFreshAuth.mockClear();
  const getComputedStyle = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
});
afterEach(() => jest.restoreAllMocks());

const GRACE = "77777777-7777-4777-8777-777777777777";
const ALAN = "88888888-8888-4888-8888-888888888888";
const NAMES = { [GRACE]: "Grace Hopper", [ALAN]: "Alan Turing" };

function pod(overrides: Partial<DashboardPod>): DashboardPod {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    handle: "cc-7f3k9q2x",
    provider: "runpod",
    key_owner_account_id: "22222222-2222-4222-8222-222222222222",
    beneficiary_account_id: "33333333-3333-4333-8333-333333333333",
    beneficiary_name: "Ada Lovelace",
    gpu_type_id: "NVIDIA RTX A5000",
    gpu_count: 1,
    cloud: "COMMUNITY",
    image: "runpod/pytorch",
    cost_per_hr: "0.27",
    max_runtime_minutes: 60,
    deadline: "2026-10-27T11:00:00.000Z",
    state: "running",
    desired_state: "running",
    created: "2026-10-27T10:00:00.000Z",
    updated: "2026-10-27T10:00:00.000Z",
    ...overrides,
  };
}

function spendResult(
  rows: Partial<GpuSpendResult["rows"][number]>[],
): GpuSpendResult {
  const full = rows.map((row) => ({
    key: GRACE,
    spent_usd: "0",
    live_estimate_usd: "0",
    held_usd: "0",
    pods: 1,
    pods_live: 0,
    ...row,
  }));
  const sum = (k: "spent_usd" | "live_estimate_usd" | "held_usd") =>
    full.reduce((t, row) => t + Number(row[k]), 0).toFixed(2);
  return {
    as_of: "2026-10-27T12:00:00.000Z",
    since: "2026-10-20T12:00:00.000Z",
    until: "2026-10-27T12:00:00.000Z",
    group_by: "beneficiary",
    rows: full,
    totals: {
      spent_usd: sum("spent_usd"),
      live_estimate_usd: sum("live_estimate_usd"),
      held_usd: sum("held_usd"),
    },
  };
}

function api(
  scope: GpuDashboardScope = "funded",
): jest.Mocked<Required<GpuCostDashboardApi>> {
  return {
    scope,
    pods: jest.fn().mockResolvedValue([
      pod({}),
      pod({
        id: "44444444-4444-4444-8444-444444444444",
        handle: "cc-agent001",
        beneficiary_account_id: "66666666-6666-4666-8666-666666666666",
        beneficiary_name: undefined,
        agent_id: "agent-1",
        cost_per_hr: "0.5",
      }),
      pod({
        id: "55555555-5555-4555-8555-555555555555",
        handle: "cc-gone0000",
        state: "terminated",
      }),
    ]),
    spend: jest
      .fn()
      .mockResolvedValue(
        spendResult([
          {
            key: GRACE,
            spent_usd: "1.25",
            live_estimate_usd: "0.5",
            pods_live: 1,
          },
        ]),
      ),
    budget: jest.fn().mockResolvedValue({
      layer_id: "l",
      version: 1,
      state: "active",
      authorized_usd: "20",
      spent_usd: "4",
      reserved_usd: "1",
      released_usd: "0",
      available_usd: "15",
      max_hourly_usd: null,
      max_concurrent_pods: null,
      max_gpu_count: null,
      max_runtime_minutes: null,
      starts_at: "2026-10-01T00:00:00.000Z",
      ends_at: "2027-10-01T00:00:00.000Z",
      live_pods: 2,
      live_gpus: 2,
    }),
    terminate: jest.fn().mockResolvedValue({ state: "terminating" }),
    killSwitch: jest
      .fn()
      .mockResolvedValue({ marked: 2, remaining: 0, paused: true }),
    resume: jest.fn().mockResolvedValue({ resumed: 1 }),
    names: jest.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, NAMES[id]])),
    ),
    projectTitle: jest.fn(() => undefined),
  };
}

// antd's id helper returns the same "test-id" for every component under jest,
// so the dialog's aria-labelledby can't resolve here; check its title instead.
async function findDialog(title: string): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(within(dialog).getByText(title)).toBeTruthy();
  return dialog;
}

describe("GpuCostDashboard", () => {
  it("shows live pods, the live rate, spend from the server and the budget", async () => {
    const mock = api();
    render(<GpuCostDashboard api={mock} />);
    expect(
      await screen.findByRole("cell", { name: "cc-7f3k9q2x" }),
    ).toBeTruthy();
    expect(screen.getByRole("cell", { name: "cc-agent001" })).toBeTruthy();
    expect(screen.queryByRole("cell", { name: "cc-gone0000" })).toBeNull();
    // Unnamed and not known to be the viewer: never "You".
    expect(
      screen.getByRole("cell", { name: "Unknown person (agent)" }),
    ).toBeTruthy();
    expect(screen.queryByRole("cell", { name: /^You/ })).toBeNull();
    expect(screen.getByText("$0.77/hour")).toBeTruthy();
    expect(
      await screen.findByRole("cell", { name: "Grace Hopper" }),
    ).toBeTruthy();
    expect(screen.getAllByText("$1.25").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$0.50").length).toBeGreaterThan(0);
    expect(await screen.findByText("$15.00 left of $20.00")).toBeTruthy();
    // no RunPod billing yet: no billed column, and no held column at zero
    expect(screen.queryByText(/Billed by RunPod/)).toBeNull();
    expect(screen.queryByText(/Held/)).toBeNull();
    expect(mock.pods).toHaveBeenCalledWith();
    expect(mock.spend).toHaveBeenCalledWith(
      expect.objectContaining({ group_by: "beneficiary" }),
    );
    expect(mock.names).toHaveBeenCalledWith([GRACE]);
  });

  it("labels the viewer's own pods as You only when the viewer is known", async () => {
    render(
      <GpuCostDashboard
        api={api()}
        viewerAccountId="33333333-3333-4333-8333-333333333333"
      />,
    );
    expect(await screen.findAllByRole("cell", { name: "You" })).toHaveLength(1);
    expect(
      screen.getByRole("cell", { name: "Unknown person (agent)" }),
    ).toBeTruthy();
  });

  it("names every control, including per-pod terminate buttons", async () => {
    render(<GpuCostDashboard api={api()} />);
    await screen.findByRole("cell", { name: "cc-7f3k9q2x" });
    expect(screen.getByRole("button", { name: "Terminate all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Terminate pod cc-7f3k9q2x" }),
    ).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Period" })).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Group spending by" }),
    ).toBeTruthy();
  });

  it("asks for confirmation, stating the scope, before terminating all", async () => {
    const mock = api();
    const user = userEvent.setup();
    render(<GpuCostDashboard api={mock} />);
    await screen.findByRole("cell", { name: "cc-7f3k9q2x" });
    await user.click(screen.getByRole("button", { name: "Terminate all" }));
    const dialog = await findDialog(
      "Terminate all GPU pods your RunPod key pays for?",
    );
    expect(within(dialog).getByText(/2 pods are live now/)).toBeTruthy();
    expect(
      within(dialog).getByText(/including pods started by agents/),
    ).toBeTruthy();
    expect(mock.killSwitch).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Terminate all" }),
    );
    expect(mock.killSwitch).toHaveBeenCalledWith();
    expect(
      await screen.findByText(
        "Marked 2 pods for termination. New launches are paused.",
      ),
    ).toBeTruthy();
    // Resume, behind fresh authentication
    await user.click(screen.getByRole("button", { name: "Resume launches" }));
    expect(mockFreshAuth).toHaveBeenCalled();
    expect(mock.resume).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("New launches are allowed again."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Resume launches" }),
    ).toBeNull();
  });

  it("says when pods are still terminating after the kill switch returns", async () => {
    const mock = api();
    mock.killSwitch.mockResolvedValueOnce({
      marked: 3,
      remaining: 1,
      paused: true,
    });
    const user = userEvent.setup();
    render(<GpuCostDashboard api={mock} />);
    await screen.findByRole("cell", { name: "cc-7f3k9q2x" });
    await user.click(screen.getByRole("button", { name: "Terminate all" }));
    const dialog = await findDialog(
      "Terminate all GPU pods your RunPod key pays for?",
    );
    expect(within(dialog).getByText(/pauses new launches/)).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Terminate all" }),
    );
    expect(
      await screen.findByText(
        "Marked 3 pods for termination. 1 pod still terminating; CoCalc keeps at it. New launches are paused.",
      ),
    ).toBeTruthy();
  });

  it("shows pods without a price, held amounts and an over-budget key honestly", async () => {
    const mock = api();
    mock.pods.mockResolvedValue([pod({ cost_per_hr: undefined })]);
    mock.spend.mockResolvedValue(
      spendResult([{ key: GRACE, spent_usd: "1", held_usd: "4" }]),
    );
    mock.budget.mockResolvedValue({
      ...(await api().budget()),
      available_usd: "0",
      over_budget_usd: "2.5",
    });
    render(<GpuCostDashboard api={mock} />);
    expect(
      await screen.findByRole("cell", { name: "not priced yet" }),
    ).toBeTruthy();
    expect(
      screen.getByText("$0.00/hour plus 1 pod not priced yet"),
    ).toBeTruthy();
    expect(
      await screen.findByRole("columnheader", { name: "Held (unconfirmed)" }),
    ).toBeTruthy();
    expect(screen.getAllByText("$4.00").length).toBeGreaterThan(0);
    expect(await screen.findByText("over by $2.50")).toBeTruthy();
  });

  it("is keyboard operable: Escape cancels and focus returns to the trigger", async () => {
    const mock = api();
    const user = userEvent.setup();
    render(<GpuCostDashboard api={mock} />);
    await screen.findByRole("cell", { name: "cc-7f3k9q2x" });
    const trigger = screen.getByRole("button", { name: "Terminate all" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(mock.killSwitch).not.toHaveBeenCalled();
  });

  it("terminates one pod after confirming, and shows errors in the dialog", async () => {
    const mock = api();
    mock.terminate.mockRejectedValueOnce(new Error("RunPod is unavailable"));
    const user = userEvent.setup();
    render(<GpuCostDashboard api={mock} />);
    await user.click(
      await screen.findByRole("button", { name: "Terminate pod cc-7f3k9q2x" }),
    );
    const dialog = await findDialog("Terminate pod cc-7f3k9q2x?");
    const confirm = within(dialog).getByRole("button", {
      name: "Terminate pod",
    });
    await user.click(confirm);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "RunPod is unavailable",
    );
    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mock.terminate).toHaveBeenLastCalledWith({
      pod_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(
      await screen.findByText("Terminating pod cc-7f3k9q2x."),
    ).toBeTruthy();
  });

  it("acts for the scope its API is bound to", async () => {
    const mock = api({ course_id: "c1" });
    const user = userEvent.setup();
    render(<GpuCostDashboard api={mock} scopeLabel="in this course" />);
    await screen.findByRole("cell", { name: "cc-7f3k9q2x" });
    await user.click(screen.getByRole("button", { name: "Terminate all" }));
    const dialog = await findDialog("Terminate all GPU pods in this course?");
    await user.click(
      within(dialog).getByRole("button", { name: "Terminate all" }),
    );
    expect(mock.killSwitch).toHaveBeenCalledWith();
  });

  it("terminates exactly the scope it shows, and doesn't refetch for an equal API object", async () => {
    const mock = api({ course_id: "c1" });
    const user = userEvent.setup();
    const { rerender } = render(
      <GpuCostDashboard api={mock} scopeLabel="in this course" />,
    );
    await screen.findByRole("cell", { name: "cc-7f3k9q2x" });
    // a new but equal API object, as a parent might pass on every render
    rerender(
      <GpuCostDashboard
        api={{ ...mock, scope: { course_id: "c1" } }}
        scopeLabel="in this course"
      />,
    );
    expect(mock.pods).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Terminate all" }));
    const dialog = await findDialog("Terminate all GPU pods in this course?");
    expect(within(dialog).getByText(/2 pods are live now/)).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Terminate all" }),
    );
    // the API is bound to the scope shown: it takes no scope argument
    expect(mock.killSwitch).toHaveBeenCalledTimes(1);
    expect(mock.killSwitch).toHaveBeenCalledWith();
  });

  it("never shows old rows under a new period while the new query is loading", async () => {
    const mock = api();
    const user = userEvent.setup();
    render(<GpuCostDashboard api={mock} />);
    await screen.findByRole("cell", { name: "Grace Hopper" });
    let resolve!: (value: Awaited<ReturnType<typeof mock.spend>>) => void;
    mock.spend.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await user.click(screen.getByText("Last 24 hours"));
    expect(
      (screen.getByRole("radio", { name: "Last 24 hours" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole("cell", { name: "Grace Hopper" })).toBeNull(),
    );
    expect(screen.queryByText("$1.25")).toBeNull();
    // A period change refetches spend only, not the pod list.
    expect(mock.pods).toHaveBeenCalledTimes(1);
    resolve(spendResult([{ key: ALAN, spent_usd: "0.5" }]));
    expect(
      await screen.findByRole("cell", { name: "Alan Turing" }),
    ).toBeTruthy();
  });

  it("hides old rows and says numbers are unavailable when a new grouping fails", async () => {
    const mock = api();
    const user = userEvent.setup();
    render(<GpuCostDashboard api={mock} />);
    await screen.findByRole("cell", { name: "Grace Hopper" });
    mock.spend.mockRejectedValue(new Error("spend is down"));
    await user.click(
      screen.getByRole("combobox", { name: "Group spending by" }),
    );
    await user.click(await screen.findByTitle("Agent"));
    expect(await screen.findByRole("alert")).toHaveTextContent("spend is down");
    expect(screen.queryByRole("cell", { name: "Grace Hopper" })).toBeNull();
    expect(screen.getAllByText("unavailable").length).toBeGreaterThan(0);
  });

  it("keeps Terminate all available but doesn't claim zero pods when pods can't load", async () => {
    const mock = api();
    mock.pods.mockRejectedValue(new Error("pods are down"));
    const user = userEvent.setup();
    render(<GpuCostDashboard api={mock} />);
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Terminate all" }));
    const dialog = await findDialog(
      "Terminate all GPU pods your RunPod key pays for?",
    );
    expect(
      within(dialog).getByText(/pod list is unavailable right now/),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/0 pods are live/)).toBeNull();
  });

  it("keeps the pod list and per-pod terminate when spend fails", async () => {
    const mock = api();
    mock.spend.mockRejectedValue(new Error("billing is down"));
    render(<GpuCostDashboard api={mock} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load GPU spending",
    );
    expect(
      await screen.findByRole("button", { name: "Terminate pod cc-7f3k9q2x" }),
    ).toBeTruthy();
    expect(screen.getByText("$0.77/hour")).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("keeps spend rows when pods fail", async () => {
    const mock = api();
    mock.pods.mockRejectedValue(new Error("inventory is down"));
    render(<GpuCostDashboard api={mock} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load live pods",
    );
    expect(
      await screen.findByRole("cell", { name: "Grace Hopper" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Unavailable.")).toBeTruthy();
  });

  it("waits for a slow pod request to settle before polling again", async () => {
    jest.useFakeTimers();
    try {
      const mock = api();
      let resolve!: (value: DashboardPod[]) => void;
      mock.pods.mockReturnValueOnce(new Promise((r) => (resolve = r)));
      render(<GpuCostDashboard api={mock} />);
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      expect(mock.pods).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolve([pod({})]);
      });
      expect(
        await screen.findByRole("cell", { name: "cc-7f3k9q2x" }),
      ).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(15_000);
      });
      expect(mock.pods).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("stops calling cached pods live when a refresh hangs, without overlapping requests", async () => {
    jest.useFakeTimers();
    try {
      const mock = api();
      const user = userEvent.setup({
        advanceTimers: jest.advanceTimersByTime,
      });
      render(<GpuCostDashboard api={mock} />);
      expect(
        await screen.findByRole("cell", { name: "cc-7f3k9q2x" }),
      ).toBeTruthy();
      expect(screen.getByText("$0.77/hour")).toBeTruthy();
      // The next poll never settles.
      mock.pods.mockReturnValueOnce(new Promise(() => {}));
      await act(async () => {
        jest.advanceTimersByTime(15_000);
      });
      expect(mock.pods).toHaveBeenCalledTimes(2);
      await act(async () => {
        jest.advanceTimersByTime(40_000);
      });
      expect(mock.pods).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("$0.77/hour")).toBeNull();
      expect(screen.getByText(/Showing the pods last loaded at/)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Terminate pod cc-7f3k9q2x" }),
      ).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Terminate all" }));
      const dialog = await findDialog(
        "Terminate all GPU pods your RunPod key pays for?",
      );
      expect(
        within(dialog).getByText(
          /Every GPU pod your RunPod key pays for will be terminated, whatever the list shows/,
        ),
      ).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it("restarts automatic polling after a manual Refresh recovers from a hung poll", async () => {
    jest.useFakeTimers();
    try {
      const mock = api();
      const user = userEvent.setup({
        advanceTimers: jest.advanceTimersByTime,
      });
      render(<GpuCostDashboard api={mock} />);
      await screen.findByRole("cell", { name: "cc-7f3k9q2x" });
      expect(mock.pods).toHaveBeenCalledTimes(1);
      mock.pods.mockReturnValueOnce(new Promise(() => {}));
      await act(async () => {
        jest.advanceTimersByTime(15_000);
      });
      expect(mock.pods).toHaveBeenCalledTimes(2);
      // Exactly one replacement request on Refresh.
      await user.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(mock.pods).toHaveBeenCalledTimes(3));
      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      expect(mock.pods).toHaveBeenCalledTimes(3);
      // One interval later, automatic polling continues.
      await act(async () => {
        jest.advanceTimersByTime(15_000);
      });
      expect(mock.pods).toHaveBeenCalledTimes(4);
      expect(screen.getByText("$0.77/hour")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it("treats cached pods as last known, not live, after a failed refresh", async () => {
    const mock = api();
    const user = userEvent.setup();
    render(<GpuCostDashboard api={mock} />);
    await screen.findByRole("cell", { name: "cc-7f3k9q2x" });
    expect(screen.getByText("$0.77/hour")).toBeTruthy();
    mock.pods.mockRejectedValueOnce(new Error("inventory is down"));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load live pods",
    );
    // The table stays, for narrow terminate actions, marked as last known.
    expect(screen.getByText(/Showing the pods last loaded at/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Terminate pod cc-7f3k9q2x" }),
    ).toBeTruthy();
    // The summary no longer calls the old numbers live.
    expect(screen.queryByText("$0.77/hour")).toBeNull();
    expect(
      screen.getAllByText(/\(as of .*; not updating\)/).length,
    ).toBeGreaterThanOrEqual(2);
    await user.click(screen.getByRole("button", { name: "Terminate all" }));
    const dialog = await findDialog(
      "Terminate all GPU pods your RunPod key pays for?",
    );
    expect(
      within(dialog).getByText(
        /pod list may be out of date.*Every GPU pod your RunPod key pays for will be terminated/,
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/pods are live now/)).toBeNull();
  });

  it("labels a course scope as the course when no label is given", async () => {
    const mock = api({ course_id: "c2" });
    const user = userEvent.setup();
    render(<GpuCostDashboard api={mock} />);
    await screen.findByRole("cell", { name: "cc-7f3k9q2x" });
    expect(
      screen.getByRole("heading", { name: "GPU pods in this course" }),
    ).toBeTruthy();
    expect(screen.queryByText(/your RunPod key pays for/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Terminate all" }));
    const dialog = await findDialog("Terminate all GPU pods in this course?");
    expect(
      within(dialog).getByText(/terminates every GPU pod in this course/),
    ).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Terminate all" }),
    );
    expect(mock.killSwitch).toHaveBeenCalledWith();
  });

  it("reports load failures in an alert", async () => {
    const mock = api();
    mock.spend.mockRejectedValue(new Error("not entitled"));
    render(<GpuCostDashboard api={mock} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("not entitled");
  });
});
