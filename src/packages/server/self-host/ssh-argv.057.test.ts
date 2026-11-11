/*
057: the bay must never run ssh with a destination that could be read as an
option, or with a remote command whose values could be read as shell syntax.

These tests put a fake "ssh" first on PATH that records the argv it was given,
so they check what is actually spawned, not just what a builder returns.
*/

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// child_process reads the real process environment, not the test's copy, so
// a PATH change would not reach it: route "ssh" to the recording fake instead.
jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: any) =>
      actual.spawn(
        cmd === "ssh" ? (globalThis as any).__FAKE_SSH__ : cmd,
        args,
        opts,
      ),
  };
});

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: async (sql: string) => {
      if (sql.includes("FROM project_hosts") && sql.includes("self-host")) {
        return {
          rows: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              status: "running",
              metadata: {
                machine: {
                  cloud: "self-host",
                  metadata: { self_host_ssh_target: "user@-oProxyCommand=id" },
                },
              },
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              status: null,
              metadata: {
                machine: {
                  cloud: "self-host",
                  metadata: { self_host_ssh_target: "-oProxyCommand=id" },
                },
              },
            },
          ],
        };
      }
      return { rows: [] };
    },
  }),
}));

let dir: string;
let argvFile: string;

function recordedArgv(): string[] | undefined {
  if (!existsSync(argvFile)) return undefined;
  return readFileSync(argvFile, "utf8").split("\0").slice(0, -1);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ssh-argv-057-"));
  argvFile = join(dir, "argv");
  const fakeSsh = join(dir, "ssh");
  writeFileSync(
    fakeSsh,
    `#!/bin/sh\nprintf '%s\\0' "$@" > '${argvFile}'\ncat > /dev/null\nexit 0\n`,
  );
  chmodSync(fakeSsh, 0o755);
  (globalThis as any).__FAKE_SSH__ = fakeSsh;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

jest.setTimeout(60_000);

describe("S2 self-host target (057)", () => {
  it("parseSshTarget keeps plain targets and refuses hostile ones", async () => {
    const { parseSshTarget } = await import("./ssh-target");
    expect(parseSshTarget(" ubuntu@10.0.0.5:2222 ")).toMatchObject({
      user: "ubuntu",
      host: "10.0.0.5",
      port: 2222,
    });
    for (const bad of [
      "-oProxyCommand=id",
      "user@-oProxyCommand=id",
      "-l@host",
      "user@host:0",
      "User@host",
      "user@169.254.169.254",
      "user@ho st",
    ]) {
      expect(parseSshTarget(bad)).toBeUndefined();
    }
  });

  it("buildSshArgs puts every option before -- and the host right after it", async () => {
    const { _test } = await import("./ssh-target");
    const args = _test.buildSshArgs(
      {
        raw: "u@h",
        host: "host.example.com",
        user: "u",
        port: 2222,
        explicit: true,
      },
      ["-N", "-R", "1:127.0.0.1:2"],
    );
    const dash = args.indexOf("--");
    expect(dash).toBe(args.length - 2);
    expect(args[dash + 1]).toBe("host.example.com");
    expect(args.slice(0, dash)).toEqual(
      expect.arrayContaining(["-l", "u", "-p", "2222", "-N", "-R"]),
    );
  });

  it("a refused target never spawns ssh (reverse tunnel)", async () => {
    const { ensureSelfHostReverseTunnel } = await import("./ssh-target");
    await expect(
      ensureSelfHostReverseTunnel({
        host_id: "33333333-3333-4333-8333-333333333333",
        ssh_target: "user@-oProxyCommand=id",
      }),
    ).rejects.toThrow("not allowed");
    expect(recordedArgv()).toBeUndefined();
  });

  it("the startup loop spawns nothing for stored hostile targets (null status too)", async () => {
    const { ensureSelfHostReverseTunnelsOnStartup } =
      await import("./ssh-target");
    await ensureSelfHostReverseTunnelsOnStartup();
    expect(recordedArgv()).toBeUndefined();
  });

  it("connector install: refused target never spawns ssh", async () => {
    const { runConnectorInstallOverSsh } = await import("./ssh-target");
    await expect(
      runConnectorInstallOverSsh({
        host_id: "44444444-4444-4444-8444-444444444444",
        ssh_target: "-oProxyCommand=id",
        pairing_token: "tok",
        ssh_port: 2222,
      }),
    ).rejects.toThrow("not allowed");
    expect(recordedArgv()).toBeUndefined();
  });

  it("connector install: hostile name and version reach install.sh as literal argv", async () => {
    const { runConnectorInstallOverSsh } = await import("./ssh-target");
    const name = `x; touch '${dir}/pwned-name' $(touch ${dir}/pwned2) \`id\` "q" 'q'\nnext -n --replace`;
    const version = `-v $HOME;touch ${dir}/pwned-version`;
    await runConnectorInstallOverSsh({
      host_id: "55555555-5555-4555-8555-555555555555",
      ssh_target: "ubuntu@10.0.0.5:2222",
      pairing_token: "pairing-token",
      ssh_port: 41234,
      name,
      version,
    });
    const argv = recordedArgv()!;
    const dash = argv.indexOf("--");
    expect(dash).toBeGreaterThan(0);
    expect(argv[dash + 1]).toBe("10.0.0.5");
    // Exactly one word after the destination: the whole remote command.
    expect(argv.length).toBe(dash + 3);
    expect(argv.slice(0, dash)).toEqual(
      expect.arrayContaining(["-l", "ubuntu", "-p", "2222"]),
    );

    // Run the remote command the way the remote login shell would, with a
    // fake curl that serves a script recording its own argv, and fake
    // loginctl/sudo. The real bash parses every quoting level.
    const remote = argv[dash + 2];
    const stub = join(dir, "stub");
    execFileSync("mkdir", ["-p", stub]);
    const installArgv = join(dir, "install-argv");
    writeFileSync(
      join(stub, "curl"),
      `#!/bin/sh\nprintf '%s\\n' 'printf "%s\\\\0" "$@" > ${installArgv}'\n`,
    );
    writeFileSync(join(stub, "loginctl"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(stub, "sudo"), "#!/bin/sh\nexit 0\n");
    // A bash wrapper records how each bash was invoked, then runs the real one.
    const realBash = execFileSync("sh", ["-c", "command -v bash"], {
      encoding: "utf8",
    }).trim();
    writeFileSync(
      join(stub, "bash"),
      `#!/bin/sh\nprintf '%s\\0' "$@" > '${dir}/bash-argv.'$$\nexec '${realBash}' "$@"\n`,
    );
    for (const f of ["curl", "loginctl", "sudo", "bash"]) {
      chmodSync(join(stub, f), 0o755);
    }
    execFileSync("sh", ["-c", remote], {
      env: { PATH: `${stub}:/usr/bin:/bin`, HOME: dir, USER: "u" },
    });
    // The remote shell runs exactly one outer command: bash -lc <whole script>.
    const outer = readdirSync(dir)
      .filter((f) => f.startsWith("bash-argv."))
      .map((f) => readFileSync(join(dir, f), "utf8").split("\0").slice(0, -1))
      .filter((a) => a[0] === "-lc");
    expect(outer).toHaveLength(1);
    expect(outer[0]).toHaveLength(2);
    expect(outer[0][1]).toMatch(/^set -euo pipefail; curl /);
    const got = readFileSync(installArgv, "utf8").split("\0").slice(0, -1);
    expect(got).toEqual([
      "--ssh-host",
      "localhost",
      "--ssh-port",
      "41234",
      "--ssh-user",
      expect.any(String),
      "--token",
      "pairing-token",
      "--ssh-no-strict-host-key-checking",
      "--replace",
      "--version",
      version,
      "--name",
      name,
    ]);
    expect(existsSync(join(dir, "pwned-name"))).toBe(false);
    expect(existsSync(join(dir, "pwned2"))).toBe(false);
    expect(existsSync(join(dir, "pwned-version"))).toBe(false);
  });
});

describe("S1 bootstrap reconcile target (057)", () => {
  const goodRow = {
    id: "66666666-6666-4666-8666-666666666666",
    metadata: {
      machine: { cloud: "gcp" },
      runtime: { public_ip: "34.82.1.2", ssh_user: "ubuntu" },
    },
  };

  it("accepts a plain user and public IP", async () => {
    const { _test, assertCloudHostBootstrapReconcileSupported } =
      await import("../conat/api/hosts-bootstrap-reconcile");
    expect(_test.cloudHostSshTarget(goodRow)).toBe("ubuntu@34.82.1.2");
    expect(() =>
      assertCloudHostBootstrapReconcileSupported(goodRow),
    ).not.toThrow();
  });

  it("refuses a stored user or address that is not allowed", async () => {
    const { _test, assertCloudHostBootstrapReconcileSupported } =
      await import("../conat/api/hosts-bootstrap-reconcile");
    const variants: any[] = [
      { public_ip: "34.82.1.2", ssh_user: "-oProxyCommand=touch /tmp/x" },
      { public_ip: "34.82.1.2", ssh_user: "Ubuntu" },
      { public_ip: "-oProxyCommand=id", ssh_user: "ubuntu" },
      { public_ip: "169.254.169.254", ssh_user: "ubuntu" },
      { public_ip: "127.0.0.1", ssh_user: "ubuntu" },
      { public_ip: "host.example.com", ssh_user: "ubuntu" },
    ];
    for (const runtime of variants) {
      const row = { ...goodRow, metadata: { ...goodRow.metadata, runtime } };
      expect(_test.cloudHostSshTarget(row)).toBeUndefined();
      expect(() => assertCloudHostBootstrapReconcileSupported(row)).toThrow();
    }
    // the machine fallbacks get the same checks
    const fallback = {
      ...goodRow,
      metadata: {
        machine: {
          cloud: "gcp",
          metadata: { public_ip: "34.82.1.2", ssh_user: "-oX=y" },
        },
      },
    };
    expect(_test.cloudHostSshTarget(fallback)).toBeUndefined();
  });

  it("spawns ssh with -- right before the destination", async () => {
    const { _test } = await import("../conat/api/hosts-bootstrap-reconcile");
    await _test.runSshScript({
      target: "ubuntu@34.82.1.2",
      script: "true",
      identityFile: "/nonexistent/key",
      hostKeyAlias: "cocalc-host-x",
    });
    const argv = recordedArgv()!;
    const dash = argv.indexOf("--");
    expect(argv.slice(dash)).toEqual(["--", "ubuntu@34.82.1.2", "bash", "-se"]);
    expect(argv.slice(0, dash)).toContain("-i");
  });
});
