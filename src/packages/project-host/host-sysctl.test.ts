import { PROJECT_HOST_SYSCTL_TARGETS, _test } from "./host-sysctl";

describe("project-host kernel sysctl policy", () => {
  it("builds the managed sysctl config", () => {
    const config = _test.buildProjectHostSysctlConfig();

    for (const [key, value] of Object.entries(PROJECT_HOST_SYSCTL_TARGETS)) {
      expect(config).toContain(`${key} = ${value}`);
    }
    expect(config).toContain("Managed by CoCalc project-host.");
  });

  it("maps sysctl keys to /proc/sys paths", () => {
    expect(_test.procPathForKey("fs.inotify.max_user_instances")).toBe(
      "/proc/sys/fs/inotify/max_user_instances",
    );
    expect(_test.procPathForKey("kernel.keys.maxbytes")).toBe(
      "/proc/sys/kernel/keys/maxbytes",
    );
  });
});
