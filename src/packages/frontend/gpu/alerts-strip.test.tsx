import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GpuAlert } from "@cocalc/util/gpu/types";
import { alertDetails, GpuAlertsStrip } from "./alerts-strip";

beforeEach(() => {
  const getComputedStyle = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
});
afterEach(() => jest.restoreAllMocks());

function alert(overrides: Partial<GpuAlert>): GpuAlert {
  return {
    id: "a1",
    credential_id: "c1",
    kind: "unknown_pod",
    severity: "critical",
    message: "A pod CoCalc didn't start is on the RunPod account of your key.",
    details: { provider_pod_id: "rp123abc", name: "miner" },
    opened: "2026-10-28T10:00:00.000Z",
    last_seen: "2026-10-28T11:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    acknowledged_at: null,
    acknowledgeable: false,
    ...overrides,
  };
}

const QUARANTINED = alert({
  id: "q1",
  kind: "quarantined_reservation",
  severity: "info",
  message: "CoCalc doesn't know whether RunPod created this pod.",
  details: { pod_id: "pod-1", handle: "cc-held0001", held_usd: "4" },
});

describe("GpuAlertsStrip", () => {
  it("renders nothing without alerts", () => {
    const { container } = render(<GpuAlertsStrip alerts={[]} />);
    expect(container.textContent).toBe("");
  });

  it("states severity in words, uses role alert only for critical ones, and shows details in words", () => {
    render(<GpuAlertsStrip alerts={[alert({}), QUARANTINED]} />);
    const critical = screen.getByRole("alert");
    expect(critical).toHaveTextContent(
      "Critical: A pod CoCalc didn't start is on your RunPod account",
    );
    expect(critical).toHaveTextContent('RunPod pod rp123abc, named "miner".');
    expect(screen.getByRole("status")).toHaveTextContent(
      "Information: Budget held for a pod CoCalc couldn't confirm",
    );
    expect(
      screen.getByText(/CoCalc pod cc-held0001, \$4\.00 held/),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "GPU alerts" }).id).toBe(
      "gpu-alerts",
    );
  });

  it("offers Acknowledge only for alerts the owner can end", async () => {
    const onAcknowledge = jest.fn(async () => {});
    const user = userEvent.setup();
    render(
      <GpuAlertsStrip
        alerts={[
          alert({}),
          alert({
            id: "u1",
            kind: "unmanaged_pod",
            severity: "warning",
            acknowledgeable: true,
          }),
        ]}
        onAcknowledge={onAcknowledge}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: /^Acknowledge/ });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]);
    expect(onAcknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1" }),
    );
  });

  it("releases a hold only after a confirmation, and shows errors in it", async () => {
    const onRelease = jest
      .fn()
      .mockRejectedValueOnce(new Error("fresh auth failed"))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<GpuAlertsStrip alerts={[QUARANTINED]} onRelease={onRelease} />);
    await user.click(
      screen.getByRole("button", { name: "Release the hold for cc-held0001" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Release the held budget?")).toBeTruthy();
    expect(within(dialog).getByText(/checking on RunPod/)).toBeTruthy();
    expect(onRelease).not.toHaveBeenCalled();
    const ok = within(dialog).getByRole("button", { name: "Release hold" });
    await user.click(ok);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "fresh auth failed",
    );
    await user.click(ok);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onRelease).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "q1" }),
      "pod-1",
    );
  });

  it("shows no actions to a viewer who can't act", () => {
    render(
      <GpuAlertsStrip
        alerts={[alert({ acknowledgeable: true }), QUARANTINED]}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("alertDetails", () => {
  it("ignores fields it doesn't know and never prints raw values", () => {
    expect(
      alertDetails(
        alert({ details: { status: 401, unverifiable: true, other: "x" } }),
      ),
    ).toEqual([]);
    expect(alertDetails(alert({ details: null }))).toEqual([]);
  });
});
