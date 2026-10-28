/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Runs the real pod start script under bash, against a fake sshd, ssh-keygen,
// curl and /start.sh in a temporary directory.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { podStartScript } from "./pod-start";

const TOKEN =
  "ccr1.bay-1.11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const URL = "https://cocalc.test/gpu/pod-host-key";

function exe(path: string, body: string) {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

// The image's sshd_config: password auth on, as measured on 10-27.
const IMAGE_CONFIG =
  "Include /etc/ssh/sshd_config.d/*.conf\nPasswordAuthentication yes\nPermitRootLogin yes\n";

function sandbox(
  opts: {
    config?: string;
    dropIns?: Record<string, string>;
    sshdTestFails?: boolean;
    codes?: string[];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pod-start-"));
  const sshDir = join(root, "etc-ssh");
  const bin = join(root, "bin");
  const out = join(root, "out");
  mkdirSync(sshDir);
  mkdirSync(join(sshDir, "sshd_config.d"));
  mkdirSync(bin);
  mkdirSync(out);
  const config = join(sshDir, "sshd_config");
  writeFileSync(
    config,
    (opts.config ?? IMAGE_CONFIG).replace(/\/etc\/ssh/g, sshDir),
  );
  for (const [name, text] of Object.entries(opts.dropIns ?? {})) {
    writeFileSync(join(sshDir, "sshd_config.d", name), text);
  }
  // ssh-keygen -A: make the host key with the real ssh-keygen.
  exe(
    join(bin, "ssh-keygen"),
    `[ "$1" = -A ] || exit 2
[ -e "${sshDir}/ssh_host_ed25519_key" ] || /usr/bin/ssh-keygen -q -t ed25519 -N "" -f "${sshDir}/ssh_host_ed25519_key"`,
  );
  // sshd -t / -T: effective values are the FIRST ones in sshd_config.
  exe(
    join(bin, "sshd"),
    `case "$1" in
  -t) ${opts.sshdTestFails ? "exit 1" : "exit 0"} ;;
  -T)
    for k in passwordauthentication kbdinteractiveauthentication permitrootlogin; do
      v=$(grep -i "^$k " "${config}" | head -1 | awk '{print tolower($2)}')
      echo "$k \${v:-yes}"
    done ;;
esac`,
  );
  exe(join(bin, "pgrep"), "exit 0");
  // curl: record argv and stdin; answer the next queued code.
  writeFileSync(join(out, "codes"), (opts.codes ?? ["200"]).join("\n") + "\n");
  exe(
    join(bin, "curl"),
    `n=$(ls "${out}" | grep -c '^call.*[.]argv$')
printf '%s\\n' "$@" > "${out}/call$n.argv"
cat > "${out}/call$n.stdin"
sed -n "$((n + 1))p" "${out}/codes"`,
  );
  // /start.sh: record the environment it got.
  exe(join(bin, "start"), `env > "${out}/start.env"`);
  const script = podStartScript({
    sshdConfig: config,
    sshDir,
    sshd: join(bin, "sshd"),
    sshKeygen: join(bin, "ssh-keygen"),
    curl: join(bin, "curl"),
    start: join(bin, "start"),
    privsepDir: join(root, "run-sshd"),
    waitSeconds: 10,
    postSeconds: 20,
    retryDelaySeconds: 1,
  });
  const run = () =>
    spawnSync("/bin/bash", ["-c", script], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        RUNPOD_POD_ID: "pod_abc123",
        CC_HOSTKEY_TOKEN: TOKEN,
        CC_HOSTKEY_URL: URL,
      },
      encoding: "utf8",
    });
  return { root, sshDir, config, out, run };
}

async function calls(out: string, n: number, ms = 15_000): Promise<string[]> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(join(out, `call${n - 1}.stdin`))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300));
  return execFileSync("ls", [out], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /^call\d+\.argv$/.test(f));
}

describe("pod start script", () => {
  it("hardens sshd, hides the token from /start.sh, and reports the host key once", async () => {
    const s = sandbox();
    const r = s.run();
    expect(r.status).toBe(0);
    // hardening comes first; the image's own config is kept below it
    const config = readFileSync(s.config, "utf8");
    expect(config.split("\n").slice(1, 4)).toEqual([
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PermitRootLogin prohibit-password",
    ]);
    expect(config).toContain("PasswordAuthentication yes");
    expect(existsSync(join(s.sshDir, "ssh_host_ed25519_key.pub"))).toBe(true);
    // /start.sh (and so sshd) never sees the token
    const startEnv = readFileSync(join(s.out, "start.env"), "utf8");
    expect(startEnv).not.toContain("CC_HOSTKEY");
    expect(startEnv).not.toContain(TOKEN);

    expect(await calls(s.out, 1)).toHaveLength(1);
    const argv = readFileSync(join(s.out, "call0.argv"), "utf8");
    const stdin = readFileSync(join(s.out, "call0.stdin"), "utf8");
    // the token only on stdin, never in argv
    expect(stdin).toBe(`Authorization: Bearer ${TOKEN}\n`);
    expect(argv).not.toContain(TOKEN);
    expect(argv).toContain("=https");
    expect(argv.split("\n")).toContain(URL);
    const key = readFileSync(join(s.sshDir, "ssh_host_ed25519_key.pub"), "utf8")
      .split(" ")
      .slice(0, 2)
      .join(" ");
    const body =
      argv.split("\n")[argv.split("\n").indexOf("--data-binary") + 1];
    expect(JSON.parse(body)).toEqual({
      pod_id: "pod_abc123",
      host_public_key: key,
    });
  });

  it("retries while the pod isn't bound yet, then stops at 200", async () => {
    const s = sandbox({ codes: ["409", "000", "200", "200"] });
    expect(s.run().status).toBe(0);
    expect(await calls(s.out, 3)).toHaveLength(3);
  });

  it("stops at a refusal and never retries it", async () => {
    const s = sandbox({ codes: ["401", "200"] });
    expect(s.run().status).toBe(0);
    expect(await calls(s.out, 1, 3000)).toHaveLength(1);
  });

  it.each([
    [
      "a Match block in sshd_config",
      {
        config: `${IMAGE_CONFIG}Match User root\n  PasswordAuthentication yes\n`,
      },
    ],
    [
      "a Match block in an included drop-in",
      { dropIns: { "50-x.conf": "  match Address *\n" } },
    ],
    [
      "an include it can't read",
      { config: `Include /nonexistent/file\n${IMAGE_CONFIG}` },
    ],
    [
      "a quoted include",
      { config: `Include "/etc/ssh/sshd_config.d/*.conf"\n` },
    ],
    ["sshd -t failing", { sshdTestFails: true }],
  ])("refuses to start sshd with %s", async (_name, opts) => {
    const s = sandbox(opts as any);
    const r = s.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cocalc: .*; not starting sshd/);
    expect(existsSync(join(s.out, "start.env"))).toBe(false);
    expect(await calls(s.out, 1, 1500)).toHaveLength(0);
  });

  it("allows drop-ins without Match, and a glob that matches nothing", async () => {
    const s = sandbox({
      dropIns: { "10-ok.conf": "# comment\nX11Forwarding no\n" },
    });
    expect(s.run().status).toBe(0);
    const s2 = sandbox({
      config: `Include /etc/ssh/none.d/*.conf\n${IMAGE_CONFIG}`,
    });
    expect(s2.run().status).toBe(0);
  });

  it("never reports when the effective config still allows passwords", async () => {
    // a later sshd -T saying "yes" (e.g. something rewrote the config)
    const s = sandbox();
    const fake = join(s.root, "bin", "sshd");
    writeFileSync(
      fake,
      `#!/bin/bash\ncase "$1" in -t) exit 0 ;; -T) echo "passwordauthentication yes"; echo "kbdinteractiveauthentication no"; echo "permitrootlogin prohibit-password" ;; esac\n`,
    );
    expect(s.run().status).toBe(0);
    expect(await calls(s.out, 1, 3000)).toHaveLength(0);
  });
});
