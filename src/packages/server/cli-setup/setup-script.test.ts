/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Runs the generated setup scripts for real (sh and dash when present), with
// a fake cocalc and curl on PATH and a file standing in for the terminal.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  errorScript,
  setupScript,
  shQuote,
  sshPlan,
  SetupActionError,
} from "./setup-script";

const SHELLS = ["/bin/sh", "/usr/bin/dash"].filter(existsSync);
const PROJECT = "11111111-2222-4333-8444-555555555555";
const SITE = "https://lite1b.cocalc.ai";

// Logs each call's arguments as [a][b]...; answers --help like commander:
// the subcommand's own usage line, or (OLD, a cocalc without it) the general
// help, still exiting 0; "auth status --check" exits AUTH_RC.
const FAKE_COCALC = `#!/bin/sh
for a in "$@"; do printf '[%s]' "$a" >> "$LOG"; done
printf '\\n' >> "$LOG"
for a in "$@"; do
  if [ "$a" = "--help" ]; then
    if [ -n "\${OLD:-}" ]; then
      echo "Usage: cocalc [options] [command]"
      exit 0
    fi
    usage="Usage: cocalc"
    for w in "$@"; do
      [ "$w" = "--help" ] || usage="$usage $w"
    done
    echo "$usage [options]"
    exit 0
  fi
done
case "$*" in
  *"auth status --check"*) exit "\${AUTH_RC:-0}" ;;
esac
exit 0
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-setup-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "home"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fake(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function run(
  shell: string,
  script: string,
  {
    answer = "",
    env = {},
  }: { answer?: string; env?: Record<string, string> } = {},
) {
  const tty = join(dir, "tty");
  writeFileSync(tty, answer);
  const log = join(dir, "log");
  writeFileSync(log, "");
  const r = spawnSync(shell, [], {
    input: script,
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
      HOME: join(dir, "home"),
      LOG: log,
      COCALC_SETUP_TTY: tty,
      ...env,
    },
  });
  return { ...r, calls: readFileSync(log, "utf8").trim().split("\n") };
}

const ssh = () => setupScript(sshPlan(SITE, PROJECT));

describe.each(SHELLS)("setup script under %s", (shell) => {
  it("signed in already: only configures SSH, with the exact arguments", () => {
    fake(join(dir, "bin", "cocalc"), FAKE_COCALC);
    const r = run(shell, ssh());
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      `[project][ssh-config][add][--help]`,
      `[--api][${SITE}][auth][status][--check]`,
      `[--api][${SITE}][project][ssh-config][add][-w][${PROJECT}]`,
    ]);
    expect(r.stdout).toContain(`Done. Connect with: ssh ${PROJECT}`);
  });

  it("not signed in: signs in first", () => {
    fake(join(dir, "bin", "cocalc"), FAKE_COCALC);
    const r = run(shell, ssh(), { env: { AUTH_RC: "1" } });
    expect(r.status).toBe(0);
    expect(r.calls.slice(2)).toEqual([
      `[--api][${SITE}][auth][login]`,
      `[--api][${SITE}][project][ssh-config][add][-w][${PROJECT}]`,
    ]);
  });

  it("no cocalc and the person says no: nothing is installed or run", () => {
    fake(join(dir, "bin", "curl"), `#!/bin/sh\necho CURL >> "$LOG"\n`);
    const r = run(shell, ssh(), { answer: "n\n" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Nothing was changed");
    expect(readFileSync(join(dir, "log"), "utf8")).toBe("");
  });

  it("no cocalc and the person says yes: installs it, then runs the step", () => {
    // The installer puts cocalc in ~/.local/bin, which isn't on PATH.
    fake(
      join(dir, "bin", "curl"),
      `#!/bin/sh
cat <<'EOF'
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/cocalc" <<'INNER'
${FAKE_COCALC}INNER
chmod +x "$HOME/.local/bin/cocalc"
EOF
`,
    );
    const r = run(shell, ssh(), { answer: "\n" });
    expect(r.status).toBe(0);
    expect(r.calls.at(-1)).toBe(
      `[--api][${SITE}][project][ssh-config][add][-w][${PROJECT}]`,
    );
  });

  it("an old cocalc first on PATH: after upgrading, uses the new one in ~/.local/bin", () => {
    // The old one doesn't know the subcommand and must never run a step.
    fake(
      join(dir, "bin", "cocalc"),
      `#!/bin/sh\necho "[OLD] $*" >> "$LOG"\necho "Usage: cocalc [options] [command]"\nexit 0\n`,
    );
    fake(
      join(dir, "bin", "curl"),
      `#!/bin/sh
cat <<'EOF'
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/cocalc" <<'INNER'
${FAKE_COCALC}INNER
chmod +x "$HOME/.local/bin/cocalc"
EOF
`,
    );
    const r = run(shell, ssh(), { answer: "y\n" });
    expect(r.status).toBe(0);
    expect(r.calls.at(-1)).toBe(
      `[--api][${SITE}][project][ssh-config][add][-w][${PROJECT}]`,
    );
    expect(
      r.calls.filter((c) => c.startsWith("[OLD]") && !c.includes("--help")),
    ).toEqual([]);
    expect(readFileSync(join(dir, "tty"), "utf8")).toContain(
      `Your cocalc (${join(dir, "bin", "cocalc")}) is too old`,
    );
  });

  it("a home directory with spaces works", () => {
    const home = join(dir, "my home");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    fake(join(home, ".local", "bin", "cocalc"), FAKE_COCALC);
    const r = run(shell, ssh(), { env: { HOME: home } });
    expect(r.status).toBe(0);
    expect(r.calls.at(-1)).toBe(
      `[--api][${SITE}][project][ssh-config][add][-w][${PROJECT}]`,
    );
  });

  it("too old: offers to upgrade; still too old after: says so and stops", () => {
    fake(join(dir, "bin", "cocalc"), FAKE_COCALC);
    fake(join(dir, "bin", "curl"), `#!/bin/sh\necho true\n`);
    const r = run(shell, ssh(), { answer: "y\n", env: { OLD: "1" } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("can't do this yet");
    expect(r.calls.some((c) => c.includes("[ssh-config][add][-w]"))).toBe(
      false,
    );
  });

  it("passes any argument exactly", () => {
    fake(join(dir, "bin", "cocalc"), FAKE_COCALC);
    const tricky = `it's $HOME \`id\` "q" \\ ;|&`;
    const r = run(
      shell,
      setupScript({ title: "t", probe: ["x"], steps: [{ args: [tricky] }] }),
    );
    expect(r.status).toBe(0);
    expect(r.calls.at(-1)).toBe(`[${tricky}]`);
  });

  it("an error script prints the reason and fails", () => {
    const r = run(shell, errorScript("that isn't a project id"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CoCalc: that isn't a project id");
  });
});

test("only real project ids; quoting refuses NUL", () => {
  expect(() => sshPlan(SITE, "x; rm -rf ~")).toThrow(SetupActionError);
  expect(() => shQuote("a\0b")).toThrow(SetupActionError);
});
