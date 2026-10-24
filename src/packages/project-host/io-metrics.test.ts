import { describe, expect, it } from "@jest/globals";

import { __test__ } from "./io-metrics";

describe("I/O containment metrics", () => {
  it("sums multi-device io.stat counters", () => {
    expect(
      __test__.parseIoStat(
        "8:16 rbytes=100 wbytes=20 rios=4 wios=2\n8:32 rbytes=7 wbytes=3 rios=1 wios=1\n",
      ),
    ).toEqual({ readBytes: 107, writeBytes: 23, readIos: 5, writeIos: 3 });
  });

  it("parses some and full pressure", () => {
    expect(
      __test__.parseIoPressure(
        "some avg10=12.50 avg60=2.00 avg300=1.00 total=1234\nfull avg10=3.25 avg60=1.00 avg300=0.50 total=456\n",
      ),
    ).toEqual({
      somePercent: 12.5,
      fullPercent: 3.25,
      fullAvg60Percent: 1,
      someTotal: 1234,
      fullTotal: 456,
    });
  });

  it("clamps reset counters instead of publishing negative rates", () => {
    expect(
      __test__.rates(
        { readBytes: 100, writeBytes: 50, readIos: 10, writeIos: 5, at: 1000 },
        { readBytes: 1, writeBytes: 2, readIos: 1, writeIos: 1, at: 2000 },
      ),
    ).toEqual({
      read_bytes_per_second: 0,
      write_bytes_per_second: 0,
      read_iops: 0,
      write_iops: 0,
    });
  });

  it("preserves explicit enforcement after a privileged status failure", () => {
    expect(
      __test__.privilegedStatusFailure(
        {
          policy_mode: "enforce",
          mountpoint: "/mnt/cocalc",
          capability: "validated",
          pool_cgroup: "/sys/fs/cgroup/cocalc-project-pool",
          devices: [],
        },
        new Error("io.max drifted"),
      ),
    ).toMatchObject({
      policy_mode: "enforce",
      capability: "unsupported",
      capability_reason: "Error: io.max drifted",
      last_reconcile_error: "Error: io.max drifted",
    });
  });

  it("keeps old helpers placement-compatible when no status was verified", () => {
    expect(
      __test__.privilegedStatusFailure(undefined, new Error("unknown command")),
    ).toMatchObject({
      policy_mode: "invalid",
      capability: "unsupported",
      last_reconcile_error: "Error: unknown command",
    });
  });
});
