import {
  createNonOverlappingAsyncRunner,
  reconcileMoveWorkerInFlight,
} from "./move-worker";

describe("createNonOverlappingAsyncRunner", () => {
  it("skips overlapping invocations while the current run is still active", async () => {
    let resolves = 0;
    let release: (() => void) | undefined;
    let started = 0;
    const runner = createNonOverlappingAsyncRunner(async () => {
      started += 1;
      if (started === 1) {
        await new Promise<void>((resolve) => {
          release = () => {
            resolves += 1;
            resolve();
          };
        });
      }
    });

    const first = runner();
    const second = runner();

    expect(await second).toBe(false);
    expect(started).toBe(1);

    release?.();

    expect(await first).toBe(true);
    expect(resolves).toBe(1);

    expect(await runner()).toBe(true);
    expect(started).toBe(2);
  });
});

describe("reconcileMoveWorkerInFlight", () => {
  it("drops stale in-memory slots that are not backed by fresh running LROs", () => {
    expect(
      reconcileMoveWorkerInFlight({
        inFlight: 1,
        freshRunning: 0,
      }),
    ).toBe(0);
  });

  it("does not invent additional in-memory slots from database state", () => {
    expect(
      reconcileMoveWorkerInFlight({
        inFlight: 1,
        freshRunning: 3,
      }),
    ).toBe(1);
  });
});
