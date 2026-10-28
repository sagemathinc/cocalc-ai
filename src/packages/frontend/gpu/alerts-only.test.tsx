import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GpuAlert } from "@cocalc/util/gpu/types";
import { GpuAlertsOnly } from "./alerts-only";

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

function alert(overrides: Partial<GpuAlert>): GpuAlert {
  return {
    id: "u1",
    credential_id: "c1",
    kind: "unmanaged_pod",
    severity: "warning",
    message:
      "A pod CoCalc launched was left running when the key was removed anyway.",
    details: { handle: "cc-unman0001" },
    opened: "2026-10-28T10:00:00.000Z",
    last_seen: "2026-10-28T11:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    acknowledged_at: null,
    acknowledgeable: true,
    ...overrides,
  };
}

function api(alerts: GpuAlert[]) {
  return {
    alerts: jest.fn().mockResolvedValue(alerts),
    acknowledgeAlert: jest.fn(async ({ id }) => ({ id }) as any),
    releaseQuarantined: jest.fn().mockResolvedValue({
      pod_id: "pod-1",
      released_usd: "4",
      warning: "Terminate it at RunPod if it still exists.",
    }),
  };
}

describe("GpuAlertsOnly (no key connected)", () => {
  it("shows nothing when there are no alerts", async () => {
    const mock = api([]);
    const { container } = render(<GpuAlertsOnly api={mock} />);
    await waitFor(() => expect(mock.alerts).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("shows a pod a forced removal left running, and acknowledges it", async () => {
    const mock = api([alert({})]);
    const user = userEvent.setup();
    render(<GpuAlertsOnly api={mock} />);
    expect(
      await screen.findByText(
        "Warning: A pod is running outside CoCalc's control",
      ),
    ).toBeTruthy();
    mock.alerts.mockResolvedValue([]);
    await user.click(
      screen.getByRole("button", {
        name: "Acknowledge: A pod is running outside CoCalc's control",
      }),
    );
    expect(mock.acknowledgeAlert).toHaveBeenCalledWith({ id: "u1" });
    expect(await screen.findByText("Alert acknowledged.")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText(/outside CoCalc's control/)).toBeNull(),
    );
  });

  it("releases a removed key's hold through fresh auth, and keeps the dialog open if it is cancelled", async () => {
    const mock = api([
      alert({
        id: "q1",
        kind: "quarantined_reservation",
        severity: "info",
        acknowledgeable: false,
        details: { pod_id: "pod-1", handle: "cc-held0001", held_usd: "4" },
      }),
    ]);
    const user = userEvent.setup();
    render(<GpuAlertsOnly api={mock} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Release the hold for cc-held0001",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    const ok = within(dialog).getByRole("button", { name: "Release hold" });
    // fresh auth cancelled: nothing released, the confirmation stays
    mockFreshAuth.mockImplementationOnce(async () => false);
    await user.click(ok);
    expect(mock.releaseQuarantined).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.click(ok);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mock.releaseQuarantined).toHaveBeenCalledWith({ pod_id: "pod-1" });
    expect(await screen.findByText("Released $4.00 held.")).toBeTruthy();
    expect(
      screen.getByText("Terminate it at RunPod if it still exists."),
    ).toBeTruthy();
  });

  it("says so when the alerts can't be read at first, instead of showing nothing", async () => {
    const mock = api([]);
    mock.alerts.mockRejectedValue(new Error("alerts unavailable"));
    render(<GpuAlertsOnly api={mock} />);
    expect(
      await screen.findByText("Couldn't load your GPU alerts"),
    ).toBeTruthy();
    expect(
      screen.getByText(/There may be alerts that aren't shown/),
    ).toBeTruthy();
  });

  it("keeps the last alerts loaded, marked as such, when a later read fails", async () => {
    const mock = api([alert({})]);
    const user = userEvent.setup();
    render(<GpuAlertsOnly api={mock} />);
    expect(
      await screen.findByText(
        "Warning: A pod is running outside CoCalc's control",
      ),
    ).toBeTruthy();
    // acknowledging reloads the alerts; that read fails
    mock.alerts.mockRejectedValue(new Error("alerts unavailable"));
    await user.click(
      screen.getByRole("button", {
        name: "Acknowledge: A pod is running outside CoCalc's control",
      }),
    );
    expect(
      await screen.findByText("Couldn't load your GPU alerts"),
    ).toBeTruthy();
    expect(screen.getByText(/Showing the alerts last loaded/)).toBeTruthy();
    expect(
      screen.getByText("Warning: A pod is running outside CoCalc's control"),
    ).toBeTruthy();
  });
});
