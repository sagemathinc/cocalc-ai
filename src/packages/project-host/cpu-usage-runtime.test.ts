/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getProjectHostCpuUsageMode } from "./cpu-usage-runtime";

describe("project-host CPU usage runtime", () => {
  const originalMode = process.env.COCALC_PROJECT_HOST_CPU_USAGE_MODE;
  const originalEnabled = process.env.COCALC_PROJECT_HOST_CPU_USAGE_ENABLED;

  beforeEach(() => {
    delete process.env.COCALC_PROJECT_HOST_CPU_USAGE_MODE;
    delete process.env.COCALC_PROJECT_HOST_CPU_USAGE_ENABLED;
  });

  afterAll(() => {
    if (originalMode == null) {
      delete process.env.COCALC_PROJECT_HOST_CPU_USAGE_MODE;
    } else {
      process.env.COCALC_PROJECT_HOST_CPU_USAGE_MODE = originalMode;
    }
    if (originalEnabled == null) {
      delete process.env.COCALC_PROJECT_HOST_CPU_USAGE_ENABLED;
    } else {
      process.env.COCALC_PROJECT_HOST_CPU_USAGE_ENABLED = originalEnabled;
    }
  });

  it("observes CPU usage by default", () => {
    expect(getProjectHostCpuUsageMode()).toBe("observe");
  });

  it("honors an explicit off override", () => {
    process.env.COCALC_PROJECT_HOST_CPU_USAGE_MODE = "off";
    expect(getProjectHostCpuUsageMode()).toBe("off");
  });

  it("supports the legacy boolean enable flag", () => {
    process.env.COCALC_PROJECT_HOST_CPU_USAGE_ENABLED = "1";
    expect(getProjectHostCpuUsageMode()).toBe("observe");
  });
});
