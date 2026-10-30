import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import bees from "./bees";
import { Filesystem } from "./filesystem";
import { applyBeesGateAction, BeesGate, beesGateEnabled } from "./bees-gate";

jest.mock("./bees", () => ({
  __esModule: true,
  BEES_ALREADY_RUNNING_EXIT_CODE: 75,
  default: jest.fn(),
  signalBeesProcessGroup: jest.fn(),
}));

jest.mock("./bees-gate", () => ({
  __esModule: true,
  applyBeesGateAction: jest.fn(async () => undefined),
  beesGateEnabled: jest.fn(() => true),
  BeesGate: jest.fn().mockImplementation(() => ({
    start: jest.fn(async () => undefined),
    stop: jest.fn(),
    getStatus: () => ({ enabled: true, frozen: true }),
  })),
}));

const mockedBees = jest.mocked(bees);
const mockedGate = jest.mocked(BeesGate);
const mockedApplyGate = jest.mocked(applyBeesGateAction);
const mockedGateEnabled = jest.mocked(beesGateEnabled);

function childProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 1234,
    killed: false,
    exitCode: null,
  });
  return child;
}

describe("BEES process supervision", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedBees.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("acquires BEES after an inherited process exits during rollout", async () => {
    const child = childProcess();
    mockedBees
      .mockResolvedValueOnce({
        status: "already-running",
        detail: "BEES_ALREADY_RUNNING pid=99",
      })
      .mockResolvedValueOnce({ status: "started", child });

    const filesystem = new Filesystem({
      mount: "/mnt/cocalc",
      rustic: "/tmp/rustic.toml",
    });
    await (filesystem as any).startBees("startup");

    expect(filesystem.getBeesStatus()).toMatchObject({
      running: true,
      external: true,
      restartAttempts: 1,
      restartPending: true,
    });

    await jest.advanceTimersByTimeAsync(1_000);

    expect(mockedBees).toHaveBeenCalledTimes(2);
    expect(filesystem.getBeesStatus()).toMatchObject({
      running: true,
      external: false,
      pid: 1234,
      restartAttempts: 0,
      restartPending: false,
    });

    filesystem.close();
  });

  it("treats a late wrapper ownership refusal as a handoff", async () => {
    const refused = childProcess();
    const replacement = childProcess();
    Object.assign(replacement, { pid: 5678 });
    mockedBees
      .mockResolvedValueOnce({ status: "started", child: refused })
      .mockResolvedValueOnce({ status: "started", child: replacement });

    const filesystem = new Filesystem({
      mount: "/mnt/cocalc",
      rustic: "/tmp/rustic.toml",
    });
    await (filesystem as any).startBees("startup");
    refused.emit("exit", 75, null);

    expect(filesystem.getBeesStatus()).toMatchObject({
      running: true,
      external: true,
      restartPending: true,
    });

    await jest.advanceTimersByTimeAsync(1_000);
    expect(filesystem.getBeesStatus()).toMatchObject({
      running: true,
      external: false,
      pid: 5678,
      restartPending: false,
    });

    filesystem.close();
  });

  it("gives a running BEES one gate, stopped on close", async () => {
    mockedGate.mockClear();
    mockedBees.mockResolvedValueOnce({
      status: "started",
      child: childProcess(),
    });
    const lifecycleActive = jest.fn(() => true);
    const filesystem = new Filesystem({
      mount: "/mnt/cocalc",
      rustic: "/tmp/rustic.toml",
      beesLifecycleActive: lifecycleActive,
    });
    await (filesystem as any).startBees("startup");

    expect(mockedGate).toHaveBeenCalledTimes(1);
    const options = mockedGate.mock.calls[0][0];
    expect(options.mount).toBe("/mnt/cocalc");
    expect(options.lifecycleActive()).toBe(true);
    const gate = mockedGate.mock.results[0].value;
    expect(gate.start).toHaveBeenCalled();
    expect(filesystem.getBeesStatus().gate).toEqual({
      enabled: true,
      frozen: true,
    });

    filesystem.close();
    expect(gate.stop).toHaveBeenCalled();
  });

  // Codex on #1503: with the gate, BEES starts frozen (when its cgroup
  // exists) rather than running until the gate's first freeze.
  it("freezes the BEES cgroup just before it starts BEES, only with the gate", async () => {
    mockedApplyGate.mockReset();
    mockedApplyGate.mockResolvedValue(undefined);
    const order: string[] = [];
    mockedApplyGate.mockImplementation(async (_mount, action) => {
      order.push(action);
    });
    mockedBees.mockImplementation(async (_mount, options) => {
      await options?.beforeSpawn?.();
      order.push("spawn");
      return { status: "started", child: childProcess() };
    });
    const gated = new Filesystem({
      mount: "/mnt/cocalc",
      rustic: "/tmp/rustic.toml",
    });
    await (gated as any).startBees("startup");
    expect(order).toEqual(["freeze", "spawn"]);
    gated.close();

    order.length = 0;
    mockedGateEnabled.mockReturnValue(false);
    try {
      const ungated = new Filesystem({
        mount: "/mnt/cocalc",
        rustic: "/tmp/rustic.toml",
      });
      await (ungated as any).startBees("startup");
      expect(order[0]).toBe("spawn");
      ungated.close();
    } finally {
      mockedGateEnabled.mockReturnValue(true);
      mockedApplyGate.mockReset();
      mockedApplyGate.mockResolvedValue(undefined);
    }
  });

  // Prod 2026-10-30: BEES was frozen and then turned off with
  // COCALC_DISABLE_BEES; the frozen BEES must not outlive the daemon.
  it("stops a leftover BEES when BEES is turned off", async () => {
    mockedGate.mockClear();
    mockedApplyGate.mockClear();
    mockedBees.mockResolvedValueOnce({ status: "disabled" });
    const filesystem = new Filesystem({
      mount: "/mnt/cocalc",
      rustic: "/tmp/rustic.toml",
    });
    await (filesystem as any).startBees("startup");

    expect(mockedApplyGate).toHaveBeenCalledWith("/mnt/cocalc", "stop");
    expect(mockedGate).not.toHaveBeenCalled();
    expect(filesystem.getBeesStatus()).toMatchObject({ enabled: false });
    filesystem.close();
  });

  it("keeps trying to stop a leftover BEES until the root helper proves it gone", async () => {
    mockedApplyGate.mockReset();
    mockedApplyGate
      .mockRejectedValueOnce(
        Error("BEES_GATE_STOP_FAILED reason=still-populated"),
      )
      .mockResolvedValueOnce(undefined);
    mockedBees.mockResolvedValueOnce({ status: "disabled" });
    const filesystem = new Filesystem({
      mount: "/mnt/cocalc",
      rustic: "/tmp/rustic.toml",
    });
    await (filesystem as any).startBees("startup");
    expect(mockedApplyGate).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockedApplyGate).toHaveBeenCalledTimes(2);
    expect(filesystem.getBeesStatus().cgroupReconcilePending).toBe(false);
    filesystem.close();
  });

  // Codex and @review on #1503: an earlier gate may have left BEES frozen.
  it("keeps the BEES cgroup thawed when the gate is turned off", async () => {
    mockedGate.mockClear();
    mockedApplyGate.mockReset();
    mockedApplyGate
      .mockRejectedValueOnce(Error("timeout"))
      .mockResolvedValueOnce(undefined);
    mockedGateEnabled.mockReturnValue(false);
    try {
      const filesystem = new Filesystem({
        mount: "/mnt/cocalc",
        rustic: "/tmp/rustic.toml",
      });
      (filesystem as any).startBeesGate();
      (filesystem as any).startBeesGate();
      await jest.advanceTimersByTimeAsync(0);
      expect(mockedApplyGate).toHaveBeenCalledTimes(1);
      expect(mockedApplyGate).toHaveBeenCalledWith("/mnt/cocalc", "thaw");
      await jest.advanceTimersByTimeAsync(60_000);
      expect(mockedApplyGate).toHaveBeenCalledTimes(2);
      // and again every minute: the previous daemon's gate may still have
      // had a freeze running
      expect(filesystem.getBeesStatus().cgroupReconcilePending).toBe(true);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(mockedApplyGate).toHaveBeenCalledTimes(3);
      expect(mockedApplyGate).toHaveBeenLastCalledWith("/mnt/cocalc", "thaw");
      expect(mockedGate).not.toHaveBeenCalled();
      filesystem.close();
      expect(filesystem.getBeesStatus().cgroupReconcilePending).toBe(false);
    } finally {
      mockedGateEnabled.mockReturnValue(true);
    }
  });
});
