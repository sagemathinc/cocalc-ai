import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComputeVm } from "@cocalc/conat/hub/api/compute";
import {
  RunningGpuIndicator,
  runningGpuSummary,
} from "./running-gpu-indicator";

let mockAccountId = "account-one";
const mockListVms = jest.fn();
const mockOpenHostsPage = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => mockAccountId,
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: { compute: { listVms: (...args) => mockListVms(...args) } },
    },
  },
}));
jest.mock("@cocalc/frontend/hosts/navigation", () => ({
  getHostsPageHref: () => "/hosts?tab=vms",
  openHostsPage: (...args) => mockOpenHostsPage(...args),
}));
function vm(overrides: Partial<ComputeVm> = {}): ComputeVm {
  return {
    gpu_count: 1,
    provider_state: "running",
    provider_observed_at: new Date().toISOString(),
    ...overrides,
  } as ComputeVm;
}
beforeEach(() => {
  const getComputedStyle = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
  mockAccountId = "account-one";
  mockListVms.mockReset().mockResolvedValue([vm()]);
  mockOpenHostsPage.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("distinguishes unknown observations from confirmed zero and counts observed rather than desired state", () => {
  expect(runningGpuSummary(undefined)).toEqual({ running: 0, unknown: true });
  expect(runningGpuSummary([])).toEqual({ running: 0, unknown: false });
  expect(runningGpuSummary([vm({ desired_state: "stopped" })])).toEqual({
    running: 1,
    unknown: false,
  });
  expect(runningGpuSummary([vm({ provider_state: "stopped" })])).toEqual({
    running: 0,
    unknown: false,
  });
  expect(
    runningGpuSummary([vm({ provider_observed_at: new Date(0).toISOString() })])
      .unknown,
  ).toBe(true);
  expect(
    runningGpuSummary([vm({ gpu_count: 0, provider_observed_at: null })]),
  ).toEqual({ running: 0, unknown: false });
});

it("keeps a keyboard-discoverable indicator after dismissing, restores focus, and links the account VM page", async () => {
  const user = userEvent.setup();
  render(<RunningGpuIndicator />);
  const trigger = await screen.findByRole("button", {
    name: "1 GPU VMs running",
  });
  expect(mockListVms).toHaveBeenCalledWith({});
  await user.tab();
  expect(trigger).toHaveFocus();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Collapse GPU reminder" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveTextContent("GPU 1");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("dialog", { name: "Account GPU virtual machines" }),
    ).toBeVisible(),
  );
  const link = screen.getByRole("link", { name: "View VMs" });
  expect(link).toHaveAttribute("href", "/hosts?tab=vms");
  act(() => link.focus());
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("link", { name: "View VMs" }));
  expect(mockOpenHostsPage).toHaveBeenCalledWith("vms");
});

it("does not leak another account's count or render failed loads as zero", async () => {
  const view = render(<RunningGpuIndicator narrow />);
  await screen.findByRole("button", { name: "1 GPU VMs running" });
  mockListVms.mockRejectedValue(new Error("offline"));
  mockAccountId = "account-two";
  view.rerender(<RunningGpuIndicator narrow />);
  expect(
    screen.getByRole("button", { name: "GPU status unknown" }),
  ).toHaveTextContent("GPU ?");
  await waitFor(() => expect(mockListVms).toHaveBeenCalledTimes(2));
  expect(
    screen.queryByRole("button", { name: "0 GPU VMs running" }),
  ).toBeNull();
});

it("ages a successful snapshot to unknown even if the next request hangs", async () => {
  jest.useFakeTimers();
  render(<RunningGpuIndicator />);
  await act(async () => {});
  expect(
    screen.getByRole("button", { name: "1 GPU VMs running" }),
  ).toBeVisible();
  mockListVms.mockImplementation(() => new Promise(() => {}));
  await act(async () => {
    jest.advanceTimersByTime(150000);
  });
  expect(
    screen.getByRole("button", { name: "GPU status unknown" }),
  ).toBeVisible();
  expect(mockListVms).toHaveBeenCalledTimes(2);
});

it("expands again when another GPU VM starts after dismissal", async () => {
  jest.useFakeTimers();
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  mockListVms.mockResolvedValue([vm({ id: "first" })]);
  render(<RunningGpuIndicator />);
  await act(async () => {});
  await user.click(
    screen.getByRole("button", { name: "Collapse GPU reminder" }),
  );
  expect(
    screen.queryByRole("button", { name: "Collapse GPU reminder" }),
  ).toBeNull();
  mockListVms.mockResolvedValue([vm({ id: "first" }), vm({ id: "second" })]);
  await act(async () => {
    jest.advanceTimersByTime(15000);
  });
  expect(
    screen.getByRole("button", { name: "2 GPU VMs running" }),
  ).toHaveTextContent("2 GPU VMs running");
  expect(
    screen.getByRole("button", { name: "Collapse GPU reminder" }),
  ).toBeVisible();
});
