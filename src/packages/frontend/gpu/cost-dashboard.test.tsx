import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GpuCostDashboard } from "./cost-dashboard";
import type { GpuCostDashboardApi, GpuPodSummary } from "./types";

beforeEach(() => {
  const getComputedStyle = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
});
afterEach(() => jest.restoreAllMocks());

function pod(overrides: Partial<GpuPodSummary>): GpuPodSummary {
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
    cost_per_hr: "0.27",
    estimated_cost: "0.54",
    state: "running",
    desired_state: "running",
    created: "2026-10-27T10:00:00.000Z",
    ...overrides,
  };
}

function api(): jest.Mocked<GpuCostDashboardApi> {
  return {
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
    spend: jest.fn().mockResolvedValue({
      as_of: "2026-10-27T12:00:00.000Z",
      billed_through: "2026-10-27T11:00:00.000Z",
      rows: [
        {
          key: "33333333-3333-4333-8333-333333333333",
          label: "Spend row Ada",
          estimated: "1.25",
          billed: "1",
          pods_live: 1,
        },
      ],
    }),
    terminate: jest.fn().mockResolvedValue({ state: "terminating" }),
    killSwitch: jest.fn().mockResolvedValue({ terminating: 2 }),
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
  it("shows live pods, the live rate and estimated vs billed spend", async () => {
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
    expect(screen.getAllByText("$1.25").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$1.00").length).toBeGreaterThan(0);
    expect(mock.pods).toHaveBeenCalledWith({ scope: "funded" });
    expect(mock.spend).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "funded", group_by: "beneficiary" }),
    );
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
    expect(mock.killSwitch).toHaveBeenCalledWith({ scope: "funded" });
    expect(await screen.findByText("Terminating 2 pods.")).toBeTruthy();
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

  it("passes a course scope through to every call", async () => {
    const mock = api();
    const user = userEvent.setup();
    render(
      <GpuCostDashboard
        api={mock}
        scope={{ course_id: "c1" }}
        scopeLabel="in this course"
      />,
    );
    await screen.findByRole("cell", { name: "cc-7f3k9q2x" });
    expect(mock.pods).toHaveBeenCalledWith({ scope: { course_id: "c1" } });
    await user.click(screen.getByRole("button", { name: "Terminate all" }));
    const dialog = await findDialog("Terminate all GPU pods in this course?");
    await user.click(
      within(dialog).getByRole("button", { name: "Terminate all" }),
    );
    expect(mock.killSwitch).toHaveBeenCalledWith({
      scope: { course_id: "c1" },
    });
  });

  it("terminates exactly the scope it shows, and doesn't refetch for an equal scope object", async () => {
    const mock = api();
    const user = userEvent.setup();
    const { rerender } = render(
      <GpuCostDashboard
        api={mock}
        scope={{ course_id: "c1" }}
        scopeLabel="in this course"
      />,
    );
    await screen.findByRole("cell", { name: "cc-7f3k9q2x" });
    rerender(
      <GpuCostDashboard
        api={mock}
        scope={{ course_id: "c1" }}
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
    expect(mock.killSwitch).toHaveBeenCalledTimes(1);
    expect(mock.killSwitch.mock.calls[0][0].scope).toEqual(
      mock.pods.mock.calls[0][0].scope,
    );
  });

  it("never shows old rows under a new period while the new query is loading", async () => {
    const mock = api();
    const user = userEvent.setup();
    render(<GpuCostDashboard api={mock} />);
    await screen.findByRole("cell", { name: "Spend row Ada" });
    let resolve!: (value: Awaited<ReturnType<typeof mock.spend>>) => void;
    mock.spend.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await user.click(screen.getByText("Last 24 hours"));
    expect(
      (screen.getByRole("radio", { name: "Last 24 hours" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole("cell", { name: "Spend row Ada" })).toBeNull(),
    );
    expect(screen.queryByText("$1.25")).toBeNull();
    // A period change refetches spend only, not the pod list.
    expect(mock.pods).toHaveBeenCalledTimes(1);
    resolve({
      as_of: "2026-10-27T12:00:00.000Z",
      rows: [
        { key: "x", label: "Grace Hopper", estimated: "0.5", pods_live: 0 },
      ],
    });
    expect(
      await screen.findByRole("cell", { name: "Grace Hopper" }),
    ).toBeTruthy();
  });

  it("hides old rows and says numbers are unavailable when a new grouping fails", async () => {
    const mock = api();
    const user = userEvent.setup();
    render(<GpuCostDashboard api={mock} />);
    await screen.findByRole("cell", { name: "Spend row Ada" });
    mock.spend.mockRejectedValue(new Error("spend is down"));
    await user.click(
      screen.getByRole("combobox", { name: "Group spending by" }),
    );
    await user.click(await screen.findByTitle("Agent"));
    expect(await screen.findByRole("alert")).toHaveTextContent("spend is down");
    expect(screen.queryByRole("cell", { name: "Spend row Ada" })).toBeNull();
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
      await screen.findByRole("cell", { name: "Spend row Ada" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Unavailable.")).toBeTruthy();
  });

  it("waits for a slow pod request to settle before polling again", async () => {
    jest.useFakeTimers();
    try {
      const mock = api();
      let resolve!: (value: GpuPodSummary[]) => void;
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
    const mock = api();
    const user = userEvent.setup();
    render(<GpuCostDashboard api={mock} scope={{ course_id: "c2" }} />);
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
    expect(mock.killSwitch).toHaveBeenCalledWith({
      scope: { course_id: "c2" },
    });
  });

  it("reports load failures in an alert", async () => {
    const mock = api();
    mock.spend.mockRejectedValue(new Error("not entitled"));
    render(<GpuCostDashboard api={mock} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("not entitled");
  });
});
