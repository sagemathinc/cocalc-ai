/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getGcpMachineBenchmark } from "./project-host-benchmarks";

describe("getGcpMachineBenchmark", () => {
  it("returns a normalized baseline score for n2d-standard machine types", () => {
    const benchmark = getGcpMachineBenchmark("n2d-standard-4");

    expect(benchmark?.representative_machine_type).toBe("n2d-standard-4");
    expect(benchmark?.cpu_platform).toBe("Milan");
    expect(benchmark?.normalized_coremark_per_vcpu).toBeCloseTo(1, 6);
    expect(benchmark?.estimated_coremark_score).toBeCloseTo(80098, 6);
  });

  it("estimates total throughput from the selected machine size", () => {
    const benchmark = getGcpMachineBenchmark("c3d-highcpu-8");

    expect(benchmark?.cpu_platform).toBe("Genoa");
    expect(benchmark?.coremark_per_vcpu).toBeCloseTo(23652.75, 2);
    expect(benchmark?.estimated_coremark_score).toBeCloseTo(189222, 0);
    expect(benchmark?.normalized_coremark_per_vcpu).toBeGreaterThan(1.1);
  });

  it("returns undefined for unsupported machine types", () => {
    expect(getGcpMachineBenchmark("h3-standard-88")).toBeUndefined();
  });
});
