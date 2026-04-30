const recordManagedProjectEgressMock = jest.fn();
const getManagedProjectEgressPolicyMock = jest.fn();

jest.mock("@cocalc/lite/hub/api", () => ({
  hubApi: {
    system: {
      recordManagedProjectEgress: (...args: any[]) =>
        recordManagedProjectEgressMock(...args),
      getManagedProjectEgressPolicy: (...args: any[]) =>
        getManagedProjectEgressPolicyMock(...args),
    },
  },
}));

import {
  __test__,
  assertManagedRawNetworkStartAllowedBestEffort,
  collectRunningProjectNetworkSamples,
  startManagedRawNetworkEgressLoop,
} from "./raw-network-egress";

describe("project-host raw network egress", () => {
  const originalMode = process.env.COCALC_PROJECT_HOST_MANAGED_EGRESS_MODE;

  beforeEach(() => {
    process.env.COCALC_PROJECT_HOST_MANAGED_EGRESS_MODE = "enforce";
    recordManagedProjectEgressMock.mockReset();
    getManagedProjectEgressPolicyMock.mockReset();
  });

  afterAll(() => {
    process.env.COCALC_PROJECT_HOST_MANAGED_EGRESS_MODE = originalMode;
  });

  it("parses the namespace boundary interface from /proc/net/route", () => {
    expect(
      __test__.parseProcNetRouteDefaultInterface(`Iface\tDestination\tGateway\tFlags
ens4\t00000000\t0100B40A\t0003
ens4\t0100B40A\t00000000\t0005
`),
    ).toBe("ens4");
  });

  it("parses tx/rx bytes from /proc/net/dev", () => {
    expect(
      __test__.parseProcNetDev(`Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 648747862   70071    0    0    0     0          0         0 648747862   70071    0    0    0     0       0          0
  ens4: 577300356   32677    0    0    0     0          0         0  2233090   20012    0    0    0     0       0          0
`),
    ).toEqual({
      lo: { rx_bytes: 648747862, tx_bytes: 648747862 },
      ens4: { rx_bytes: 577300356, tx_bytes: 2233090 },
    });
  });

  it("collects tx bytes from the project boundary interface", async () => {
    const sample = await collectRunningProjectNetworkSamples({
      podmanCommand: jest
        .fn()
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              Id: "ctr-1",
              Names: ["project-11111111-1111-4111-8111-111111111111"],
            },
          ]),
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              Name: "/project-11111111-1111-4111-8111-111111111111",
              State: { Pid: 1234 },
            },
          ]),
        }),
      readFileFn: jest.fn().mockImplementation(async (path: string) =>
        path.endsWith("/route")
          ? `Iface\tDestination\tGateway\tFlags
ens4\t00000000\t0100B40A\t0003
ens4\t0100B40A\t00000000\t0005
`
          : `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0
  ens4: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0
`,
      ),
    });

    expect(sample).toEqual([
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        pid: 1234,
        interface_name: "ens4",
        tx_bytes: 200,
      },
    ]);
  });

  it("blocks project start when raw network egress policy is exceeded", async () => {
    getManagedProjectEgressPolicyMock.mockResolvedValue({
      allowed: false,
      blocked_by: "5h",
      managed_egress_5h_bytes: 12_000_000,
      egress_5h_bytes: 10_000_000,
      managed_egress_categories_5h_bytes: {
        "raw-network": 11_000_000,
      },
    });

    await expect(
      assertManagedRawNetworkStartAllowedBestEffort({
        project_id: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toThrow("Project outbound network traffic limit reached.");
  });

  it("allows project start if the policy lookup fails", async () => {
    getManagedProjectEgressPolicyMock.mockRejectedValue(
      new Error("temporary hub error"),
    );

    await expect(
      assertManagedRawNetworkStartAllowedBestEffort({
        project_id: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toBeUndefined();
  });

  it("treats the first sample as a baseline instead of billable egress", () => {
    expect(
      __test__.summarizeManagedRawNetworkEgressDeltas({
        previous: new Map(),
        current: new Map([
          [
            "11111111-1111-4111-8111-111111111111",
            {
              project_id: "11111111-1111-4111-8111-111111111111",
              pid: 1234,
              interface_name: "ens4",
              tx_bytes: 1500,
            },
          ],
        ]),
      }),
    ).toEqual([]);
  });

  it("ignores counter resets and interface changes", () => {
    const previous = new Map([
      [
        "11111111-1111-4111-8111-111111111111",
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          pid: 1234,
          interface_name: "ens4",
          tx_bytes: 1500,
        },
      ],
    ]);

    expect(
      __test__.summarizeManagedRawNetworkEgressDeltas({
        previous,
        current: new Map([
          [
            "11111111-1111-4111-8111-111111111111",
            {
              project_id: "11111111-1111-4111-8111-111111111111",
              pid: 1234,
              interface_name: "ens4",
              tx_bytes: 100,
            },
          ],
        ]),
      }),
    ).toEqual([]);

    expect(
      __test__.summarizeManagedRawNetworkEgressDeltas({
        previous,
        current: new Map([
          [
            "11111111-1111-4111-8111-111111111111",
            {
              project_id: "11111111-1111-4111-8111-111111111111",
              pid: 1234,
              interface_name: "eth0",
              tx_bytes: 2000,
            },
          ],
        ]),
      }),
    ).toEqual([]);
  });

  it("records deltas after the baseline and stops over-limit projects", async () => {
    const stopMock = jest.fn().mockResolvedValue({ state: "opened" });
    recordManagedProjectEgressMock.mockResolvedValue({ recorded: true });
    getManagedProjectEgressPolicyMock.mockResolvedValue({
      allowed: false,
      blocked_by: "5h",
    });
    const sample = jest
      .fn()
      .mockResolvedValueOnce([
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          pid: 1234,
          interface_name: "ens4",
          tx_bytes: 1500,
        },
      ])
      .mockResolvedValueOnce([
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          pid: 1234,
          interface_name: "ens4",
          tx_bytes: 2000,
        },
      ])
      .mockResolvedValue([
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          pid: 1234,
          interface_name: "ens4",
          tx_bytes: 2000,
        },
      ]);

    const stop = startManagedRawNetworkEgressLoop({
      runnerApi: { stop: stopMock } as any,
      intervalMs: 10,
      sample: sample as any,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();

    expect(recordManagedProjectEgressMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "11111111-1111-4111-8111-111111111111",
        category: "raw-network",
        bytes: 500,
      }),
    );
    expect(stopMock).toHaveBeenCalledWith({
      project_id: "11111111-1111-4111-8111-111111111111",
      force: true,
    });
  });
});
