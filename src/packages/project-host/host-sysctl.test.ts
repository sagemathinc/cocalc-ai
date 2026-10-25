import {
  PROJECT_HOST_KERNEL_HARDENING,
  PROJECT_HOST_SYSCTL_TARGETS,
  PROJECT_HOST_SYSCTL_TEXT_TARGETS,
  _test,
} from "./host-sysctl";

describe("project-host kernel sysctl policy", () => {
  it("builds the managed sysctl config", () => {
    const config = _test.buildProjectHostSysctlConfig();

    for (const [key, value] of Object.entries(PROJECT_HOST_SYSCTL_TARGETS)) {
      expect(config).toContain(`${key} = ${value}`);
    }
    for (const [key, value] of Object.entries(
      PROJECT_HOST_SYSCTL_TEXT_TARGETS,
    )) {
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
    expect(_test.procPathForKey("net.ipv4.ip_local_port_range")).toBe(
      "/proc/sys/net/ipv4/ip_local_port_range",
    );
  });

  it("normalizes whitespace in text sysctl values", () => {
    expect(_test.normalizeTextSysctlValue("10000\t65535\n")).toBe(
      "10000 65535",
    );
  });

  it("builds the managed hardening config from the managed keys only", () => {
    expect(_test.buildProjectHostHardeningSysctlConfig()).toBe(
      [
        "# Managed by CoCalc project-host: kernel attack surface reduction.",
        "kernel.io_uring_disabled = 2",
        "vm.unprivileged_userfaultfd = 0",
        "",
      ].join("\n"),
    );
    expect(
      PROJECT_HOST_KERNEL_HARDENING.filter(
        ({ managed }) => managed == null,
      ).map(({ key }) => key),
    ).toEqual([
      "kernel.apparmor_restrict_unprivileged_userns",
      "kernel.unprivileged_bpf_disabled",
      "kernel.perf_event_paranoid",
    ]);
  });

  it("accepts the hardened values and stricter image defaults", () => {
    const snapshot = _test.evaluateHardening({
      "kernel.io_uring_disabled": 2,
      "vm.unprivileged_userfaultfd": 0,
      "kernel.apparmor_restrict_unprivileged_userns": 1,
      "kernel.unprivileged_bpf_disabled": 2,
      "kernel.perf_event_paranoid": 4,
    });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.checks.every(({ ok }) => ok)).toBe(true);
  });

  it("reports drift and missing keys, and which drift the host can fix", () => {
    const snapshot = _test.evaluateHardening({
      "kernel.io_uring_disabled": 0,
      "vm.unprivileged_userfaultfd": 1,
      "kernel.apparmor_restrict_unprivileged_userns": 0,
      "kernel.unprivileged_bpf_disabled": null,
      "kernel.perf_event_paranoid": 2,
    });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.checks).toEqual([
      {
        key: "kernel.io_uring_disabled",
        expected: ">= 2",
        actual: 0,
        ok: false,
        managed: true,
      },
      {
        key: "vm.unprivileged_userfaultfd",
        expected: "<= 0",
        actual: 1,
        ok: false,
        managed: true,
      },
      {
        key: "kernel.apparmor_restrict_unprivileged_userns",
        expected: ">= 1",
        actual: 0,
        ok: false,
        managed: false,
      },
      {
        key: "kernel.unprivileged_bpf_disabled",
        expected: ">= 1",
        actual: null,
        ok: false,
        managed: false,
      },
      {
        key: "kernel.perf_event_paranoid",
        expected: ">= 3",
        actual: 2,
        ok: false,
        managed: false,
      },
    ]);
    const base = {
      targets: {},
      values: {},
      ok: true,
      mismatches: [],
    };
    expect(_test.managedHardeningDrift({ ...base, hardening: snapshot })).toBe(
      true,
    );
    // Drift only in checked-but-unmanaged settings is reported, not "fixed".
    expect(
      _test.managedHardeningDrift({
        ...base,
        hardening: _test.evaluateHardening({
          "kernel.io_uring_disabled": 2,
          "vm.unprivileged_userfaultfd": 0,
          "kernel.apparmor_restrict_unprivileged_userns": 0,
          "kernel.unprivileged_bpf_disabled": 0,
          "kernel.perf_event_paranoid": 0,
        }),
      }),
    ).toBe(false);
    expect(_test.managedHardeningDrift(base)).toBe(false);
  });
});
