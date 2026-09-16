import { JupyterKernel } from "./kernel";
import * as launcher from "./launch-kernel";
import type { SpawnedKernel } from "./launch-kernel";
import * as remoteLauncher from "./remote-launcher";
import * as kernelData from "@cocalc/jupyter/kernel/kernel-data";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function launchedKernel(): SpawnedKernel {
  return {
    spawn: {
      kill: jest.fn(),
      stdout: { destroy: jest.fn() },
      stderr: { destroy: jest.fn() },
      stdin: { destroy: jest.fn() },
    },
    connectionFile: "",
    config: {} as SpawnedKernel["config"],
    kernel_spec: { metadata: { reflect: { remote: true } } },
  };
}

it("cleans up a late launch exactly once before admitting its replacement", async () => {
  const enteredLaunch = deferred<void>();
  const pendingLaunch = deferred<SpawnedKernel>();
  const enteredStop = deferred<void>();
  const pendingStop = deferred<void>();
  const late = launchedKernel();
  const replacement = launchedKernel();
  jest
    .spyOn(kernelData, "get_kernel_data_by_name")
    .mockResolvedValue({ argv: ["reflect"] } as any);
  const launch = jest.spyOn(launcher, "default");
  launch.mockImplementationOnce(() => {
    enteredLaunch.resolve();
    return pendingLaunch.promise;
  });
  launch.mockResolvedValueOnce(replacement);
  const stop = jest
    .spyOn(remoteLauncher, "stopReflectLauncher")
    .mockImplementationOnce(() => {
      enteredStop.resolve();
      return pendingStop.promise;
    })
    .mockResolvedValue(undefined);
  const first = new JupyterKernel(
    "reflect-test",
    "late-launch.ipynb",
    undefined,
    undefined,
  );
  const finishFirst = jest
    .spyOn(first as any, "finishSpawningKernel")
    .mockResolvedValue(undefined);
  let second: JupyterKernel | undefined;
  let secondSpawn: Promise<void> | undefined;
  const firstSpawn = first.spawn();
  try {
    // Close only after launch_wait is assigned, not during kernelspec lookup.
    await enteredLaunch.promise;
    first.close();
    first.close();
    let closed = false;
    const closing = first.waitUntilClosed().then(() => {
      closed = true;
    });
    second = new JupyterKernel(
      "reflect-test",
      "late-launch.ipynb",
      undefined,
      undefined,
    );
    const finishSecond = jest
      .spyOn(second as any, "finishSpawningKernel")
      .mockResolvedValue(undefined);
    secondSpawn = second.spawn();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    pendingLaunch.resolve(late);
    await enteredStop.promise;
    await firstSpawn;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(first.isClosed()).toBe(true);
    expect(first.get_spawned_kernel()).toBeUndefined();
    expect(finishFirst).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(late.spawn);
    expect(late.spawn.stdout.destroy).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(finishSecond).not.toHaveBeenCalled();

    first.close();
    pendingStop.resolve();
    await closing;
    await secondSpawn;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(late.spawn.kill).toHaveBeenCalledTimes(1);
    expect(late.spawn.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(late.spawn.stderr.destroy).toHaveBeenCalledTimes(1);
    expect(late.spawn.stdin.destroy).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(finishSecond).toHaveBeenCalledTimes(1);
    expect(second.get_spawned_kernel()).toBe(replacement);
  } finally {
    pendingLaunch.resolve(late);
    pendingStop.resolve();
    await firstSpawn;
    first.close();
    await first.waitUntilClosed();
    await secondSpawn;
    second?.close();
    await second?.waitUntilClosed();
    jest.restoreAllMocks();
  }
});
