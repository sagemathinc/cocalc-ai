import { waitForProjectHostRoutingAfterMove } from "./project_actions";

describe("ProjectActions host routing wait", () => {
  it("waits for the destination host id and host info before resolving", async () => {
    let currentHostIdChecks = 0;
    let hostInfoReady = false;
    const ensureHostInfo = jest.fn(
      async (_host_id: string, force?: boolean) => {
        if (force) {
          hostInfoReady = true;
        }
      },
    );
    const resolveRoutedClient = jest.fn(async () => undefined);

    await waitForProjectHostRoutingAfterMove({
      project_id: "00000000-0000-4000-8000-000000000001",
      source_host_id: "source-host",
      dest_host_id: "dest-host",
      getProjectHostId: () => {
        currentHostIdChecks += 1;
        return currentHostIdChecks >= 2 ? "dest-host" : "source-host";
      },
      hasHostInfo: () => hostInfoReady,
      ensureHostInfo,
      resolveRoutedClient,
      startDelayMs: 1,
      maxDelayMs: 1,
      maxWaitMs: 50,
    });

    expect(ensureHostInfo).toHaveBeenCalledWith("dest-host", true);
    expect(resolveRoutedClient).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when there is no destination host", async () => {
    const resolveRoutedClient = jest.fn(async () => undefined);

    await waitForProjectHostRoutingAfterMove({
      project_id: "00000000-0000-4000-8000-000000000001",
      getProjectHostId: () => undefined,
      hasHostInfo: () => false,
      ensureHostInfo: jest.fn(),
      resolveRoutedClient,
      startDelayMs: 1,
      maxDelayMs: 1,
      maxWaitMs: 10,
    });

    expect(resolveRoutedClient).not.toHaveBeenCalled();
  });
});
