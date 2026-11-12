import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxShellScript } from "./sandbox-exec";

// project_exec runs scripts with `bash -lc`. The project's profile runs
// first and may put its own directories (/usr/bin, ~/.cargo/bin, ...) before
// the CLI connector wrappers, so a plain `gh` would not be signed in.

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "sandbox-connector-path-"));
  for (const name of ["profile-bin", "connector-bin"]) {
    await fs.mkdir(join(dir, name));
    await fs.writeFile(join(dir, name, "tool"), `#!/bin/sh\necho ${name}\n`, {
      mode: 0o755,
    });
  }
  // A profile that does what /etc/profile.d scripts in project images do.
  await fs.writeFile(
    join(dir, ".bash_profile"),
    `export PATH="${join(dir, "profile-bin")}:$PATH"\n`,
  );
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function loginShell(script: string, env: Record<string, string>) {
  return spawnSync("/bin/bash", ["-lc", script], {
    env: { HOME: dir, PATH: "/usr/bin:/bin", ...env },
    encoding: "utf8",
  }).stdout.trim();
}

test("the connector wrappers stay first on PATH after the login profile", () => {
  const env = {
    COCALC_CONNECTOR_BIN: join(dir, "connector-bin"),
    PATH: `${join(dir, "connector-bin")}:/usr/bin:/bin`,
  };
  // What used to happen: the profile wins.
  expect(loginShell("tool", env)).toBe("profile-bin");
  expect(loginShell(sandboxShellScript("tool", env), env)).toBe(
    "connector-bin",
  );
});

test("scripts run unchanged without a connector", () => {
  expect(sandboxShellScript("echo hi")).toBe("echo hi");
  expect(sandboxShellScript("echo hi", { OTHER: "x" })).toBe("echo hi");
  expect(sandboxShellScript("echo hi", { COCALC_CONNECTOR_BIN: "" })).toBe(
    "echo hi",
  );
});

test("the line keeps the script's own exit status and output", () => {
  const env = { COCALC_CONNECTOR_BIN: join(dir, "connector-bin") };
  const result = spawnSync(
    "/bin/bash",
    ["-lc", sandboxShellScript("echo out; exit 7", env)],
    { env: { HOME: dir, PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" },
  );
  expect(result.stdout).toBe("out\n");
  expect(result.status).toBe(7);
});
