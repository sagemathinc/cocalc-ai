/*
057: every bay-side ssh argv puts "--" right before the destination, and the
sites that take a host-derived user or address check it first.
*/

import { assertHostSshMetadataAllowed, hostSshUser } from "./host-ssh-metadata";

function expectDestinationAfterDashes(args: string[], destination: string) {
  const dash = args.indexOf("--");
  expect(dash).toBeGreaterThan(0);
  expect(args[dash + 1]).toBe(destination);
  // nothing before "--" is the destination
  expect(args.slice(0, dash)).not.toContain(destination);
}

describe("host ssh metadata checks", () => {
  it("assertHostSshMetadataAllowed accepts plain values and refuses others", () => {
    expect(() =>
      assertHostSshMetadataAllowed({
        ssh_user: "ubuntu",
        public_ip: "34.82.1.2",
        self_host_ssh_target: "user@10.0.0.5:22",
      }),
    ).not.toThrow();
    expect(() => assertHostSshMetadataAllowed(undefined)).not.toThrow();
    expect(() => assertHostSshMetadataAllowed({})).not.toThrow();
    for (const bad of [
      { ssh_user: "-oProxyCommand=id" },
      { ssh_user: "" },
      { ssh_user: 5 },
      { public_ip: "127.0.0.1" },
      { public_ip: "host.example.com" },
      { public_ip: "" },
      { self_host_ssh_target: "-oProxyCommand=id" },
      { self_host_ssh_target: "" },
    ]) {
      expect(() => assertHostSshMetadataAllowed(bad)).toThrow();
    }
  });

  it("hostSshUser falls back only for a missing value", () => {
    expect(hostSshUser(undefined)).toBe("ubuntu");
    expect(hostSshUser(null, "local")).toBe("local");
    expect(hostSshUser("root")).toBe("root");
    expect(() => hostSshUser("")).toThrow();
    expect(() => hostSshUser("-l")).toThrow();
  });
});

describe("compute ssh argv (S3)", () => {
  it("managed VM readiness", async () => {
    const { managedVmReadinessSshArgs } = await import("../compute/worker");
    const args = managedVmReadinessSshArgs({
      privateKeyPath: "/k",
      destination: "user@34.82.1.2",
      command: "true",
    });
    expectDestinationAfterDashes(args, "user@34.82.1.2");
    expect(args[args.length - 1]).toBe("true");
  });

  it("windows powershell", async () => {
    const { windowsPowerShellSshArgs } = await import("../compute/provider");
    const args = windowsPowerShellSshArgs({
      privateKeyPath: "/k",
      destination: "user@34.82.1.2",
      encoded: "AAAA",
    });
    expectDestinationAfterDashes(args, "user@34.82.1.2");
    expect(args[args.length - 1]).toBe("AAAA");
  });

  it("nebius key sync", async () => {
    const { nebiusManagedSshKeySyncArgs } = await import("../compute/provider");
    const args = nebiusManagedSshKeySyncArgs({
      privateKeyPath: "/k",
      host: "34.82.1.2",
      encoded: "AAAA",
    });
    expectDestinationAfterDashes(args, "user@34.82.1.2");
  });
});

describe("operator and admin scripts (S4-S7)", () => {
  it("smoke self-host ssh readiness (S5)", async () => {
    const { sshReadyArgs } = await import("./smoke-runner/self-host");
    const args = sshReadyArgs("ubuntu@10.0.0.5");
    expectDestinationAfterDashes(args, "ubuntu@10.0.0.5");
  });

  it("rustic benchmark remote python (S6)", async () => {
    const { remotePythonSshArgs } =
      await import("./smoke-runner/project-backup-rustic-scale");
    const args = remotePythonSshArgs({
      host: "10.0.0.5",
      user: "ubuntu",
      port: 2222,
      identity: "/k",
      sudo_user: "cocalc",
    });
    expectDestinationAfterDashes(args, "ubuntu@10.0.0.5");
    expect(args.slice(args.indexOf("--") + 2)).toEqual([
      "sudo",
      "-u",
      "cocalc",
      "python3",
      "-",
    ]);
    for (const [user, host] of [
      ["-oProxyCommand=id", "10.0.0.5"],
      ["ubuntu", "-oProxyCommand=id"],
      ["ubuntu", "169.254.169.254"],
    ]) {
      expect(() => remotePythonSshArgs({ host, user, port: 22 })).toThrow(
        "not allowed",
      );
    }
  });

  it("legacy scan (S4)", async () => {
    const { scanHostSshArgs } =
      await import("../legacy-migration/scan-ssh-args");
    const args = scanHostSshArgs({ sshUser: "ubuntu", host: "34.82.1.2" });
    expectDestinationAfterDashes(args, "ubuntu@34.82.1.2");
    for (const [sshUser, host] of [
      ["-oX=y", "34.82.1.2"],
      ["ubuntu", "-oX=y"],
      ["ubuntu", "host.example.com"],
      ["ubuntu", "127.0.0.1"],
    ]) {
      expect(() => scanHostSshArgs({ sshUser, host })).toThrow("not allowed");
    }
  });
});
