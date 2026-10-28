import {
  GPU_REQUEST_TIMEOUT_MS,
  hubGpuDashboardApi,
} from "./hub-dashboard-api";

const OWNER = "11111111-1111-4111-8111-111111111111";
const STUDENT = "22222222-2222-4222-8222-222222222222";

function hub() {
  return {
    pods: jest.fn().mockResolvedValue({
      provider: "runpod",
      as_of: "2026-10-28T12:00:00.000Z",
      scope: "managed",
      pods: [],
      records: [
        {
          id: "a",
          key_owner_account_id: OWNER,
          beneficiary_account_id: STUDENT,
        },
        // a pod the viewer is responsible for, on someone else's key: not
        // what the viewer's kill switch terminates, so not shown here
        {
          id: "b",
          key_owner_account_id: STUDENT,
          beneficiary_account_id: OWNER,
        },
      ],
    }),
    spend: jest.fn().mockResolvedValue({ rows: [] }),
    budget: jest.fn().mockResolvedValue({}),
    terminate: jest.fn().mockResolvedValue({ state: "terminating" }),
    killSwitch: jest
      .fn()
      .mockResolvedValue({ marked: 1, remaining: 0, paused: true }),
    resume: jest.fn().mockResolvedValue({ resumed: 1 }),
    reportCompromised: jest.fn().mockResolvedValue({ closed: false }),
    alerts: jest.fn().mockResolvedValue([]),
    acknowledgeAlert: jest.fn().mockResolvedValue({ id: "a1" }),
    releaseQuarantined: jest.fn().mockResolvedValue({
      pod_id: "p",
      released_usd: "1",
      warning: "",
    }),
  };
}

describe("hubGpuDashboardApi", () => {
  it("shows only pods the viewer's key pays for, with the beneficiaries' names", async () => {
    const gpu = hub();
    const names = jest.fn(async () => ({ [STUDENT]: "Grace Hopper" }));
    const api = hubGpuDashboardApi({
      gpu: gpu as any,
      viewerAccountId: OWNER,
      names,
    });
    expect(api.scope).toBe("funded");
    const pods = await api.pods();
    expect(pods.map((p) => [p.id, p.beneficiary_name])).toEqual([
      ["a", "Grace Hopper"],
    ]);
    expect(gpu.pods).toHaveBeenCalledWith({
      scope: "managed",
      include_ended: true,
      timeout: GPU_REQUEST_TIMEOUT_MS,
    });
    expect(names).toHaveBeenCalledWith([STUDENT]);
  });

  it("still shows the pods when names can't be loaded", async () => {
    const api = hubGpuDashboardApi({
      gpu: hub() as any,
      viewerAccountId: OWNER,
      names: async () => {
        throw Error("names are down");
      },
    });
    expect((await api.pods()).map((p) => p.id)).toEqual(["a"]);
  });

  it("gives every call a 20 s transport timeout, and fresh-auth calls the browser id", async () => {
    const gpu = hub();
    const api = hubGpuDashboardApi({
      gpu: gpu as any,
      viewerAccountId: OWNER,
      browserId: "browser-1",
    });
    const t = { timeout: 20_000 };
    await api.spend({ since: "2026-10-01T00:00:00.000Z", group_by: "agent" });
    expect(gpu.spend).toHaveBeenCalledWith({
      since: "2026-10-01T00:00:00.000Z",
      group_by: "agent",
      ...t,
    });
    await api.budget!();
    expect(gpu.budget).toHaveBeenCalledWith(t);
    await api.terminate({ pod_id: "a" });
    expect(gpu.terminate).toHaveBeenCalledWith({ pod_id: "a", ...t });
    expect(await api.killSwitch()).toEqual({
      marked: 1,
      remaining: 0,
      paused: true,
    });
    // the owner's account kill switch: no project, so it also pauses
    expect(gpu.killSwitch).toHaveBeenCalledWith(t);
    await api.resume!();
    expect(gpu.resume).toHaveBeenCalledWith({ browser_id: "browser-1", ...t });
    await api.alerts!();
    expect(gpu.alerts).toHaveBeenCalledWith(t);
    await api.acknowledgeAlert!({ id: "a1" });
    expect(gpu.acknowledgeAlert).toHaveBeenCalledWith({ id: "a1", ...t });
    await api.releaseQuarantined!({ pod_id: "p" });
    expect(gpu.releaseQuarantined).toHaveBeenCalledWith({
      pod_id: "p",
      browser_id: "browser-1",
      ...t,
    });
    await api.reportCompromised({ confirm_cocalc_only: true });
    expect(gpu.reportCompromised).toHaveBeenCalledWith({
      confirm_cocalc_only: true,
      browser_id: "browser-1",
      ...t,
    });
  });
});
