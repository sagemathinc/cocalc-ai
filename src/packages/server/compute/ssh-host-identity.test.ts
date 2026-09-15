import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedVmSshHostIdentityScript } from "./ssh-host-identity";

it("preserves all presented host keys when cloud-init replaces its default keys", () => {
  const root = mkdtempSync(join(tmpdir(), "vm-host-keys-"));
  try {
    const ssh = join(root, "etc-ssh");
    const state = join(root, "state");
    mkdirSync(ssh);
    const script = managedVmSshHostIdentityScript()
      .replaceAll("/etc/ssh", ssh)
      .replaceAll("/var/lib/cocalc-managed-vm", state);
    execFileSync("bash", ["-n"], { input: script });
    for (const type of ["ed25519", "ecdsa", "rsa"]) {
      writeFileSync(join(ssh, `ssh_host_${type}_key`), `initial-${type}`);
    }
    const run = () => execFileSync("bash", ["-eu"], { input: script });
    run();
    const config = readFileSync(
      join(ssh, "sshd_config.d/00-cocalc-host-keys.conf"),
      "utf8",
    );
    for (const type of ["ed25519", "ecdsa", "rsa"]) {
      writeFileSync(join(ssh, `ssh_host_${type}_key`), `replacement-${type}`);
    }
    run();
    expect(
      readFileSync(join(ssh, "sshd_config.d/00-cocalc-host-keys.conf"), "utf8"),
    ).toBe(config);
    for (const type of ["ed25519", "ecdsa", "rsa"]) {
      const key = join(state, `ssh-host-keys/ssh_host_${type}_key`);
      expect(readFileSync(key, "utf8")).toBe(`initial-${type}`);
      expect(statSync(key).mode & 0o777).toBe(0o600);
      expect(config).toContain(`HostKey ${key}\n`);
    }
    expect(statSync(join(state, "ssh-host-keys")).mode & 0o777).toBe(0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("fails without publishing an empty configuration when no keys exist", () => {
  const root = mkdtempSync(join(tmpdir(), "vm-host-keys-"));
  try {
    const ssh = join(root, "etc-ssh");
    const script = managedVmSshHostIdentityScript()
      .replaceAll("/etc/ssh", ssh)
      .replaceAll("/var/lib/cocalc-managed-vm", join(root, "state"));
    expect(() =>
      execFileSync("bash", ["-eu"], { input: script, stdio: "pipe" }),
    ).toThrow();
    expect(
      existsSync(join(ssh, "sshd_config.d/00-cocalc-host-keys.conf")),
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
