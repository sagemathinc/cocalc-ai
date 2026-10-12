/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// One-line setup for things done with the CoCalc command line on your own
// computer (connect it as a computer, set up SSH to a project):
//
//   curl -fsSL '<site>/api/v2/cli/setup?action=...' | sh
//
// The script checks that `cocalc` is installed and new enough for the step,
// offers to install or upgrade it (asking on the terminal), then runs the
// step. It is generated here from a fixed set of actions with validated
// arguments; nothing in it comes from the request except those arguments,
// and every argument is shell-quoted.

import { isValidUUID } from "@cocalc/util/misc";

/** The official installer (see packages/cli/README.md). */
export const CLI_INSTALLER_URL =
  "https://software.cocalc.ai/software/cocalc/install.sh";

export class SetupActionError extends Error {}

export interface SetupStep {
  /** What to say before running it. */
  say?: string;
  /** cocalc's arguments. */
  args: string[];
  /** Skip the step when these cocalc arguments succeed (e.g. signed in). */
  unless?: string[];
}

export interface SetupPlan {
  /** One line, for the header comment. */
  title: string;
  /**
   * The cocalc subcommand the steps need, as words (e.g. ["computer",
   * "connect"]). A version is new enough when its help for exactly that
   * subcommand says so: an old cocalc answers `<unknown> --help` with its
   * general help and exit 0, so the exit code alone proves nothing.
   */
  probe: string[];
  steps: SetupStep[];
  /** Printed at the end. */
  done?: string;
}

/** POSIX single quotes: exact for any string without NUL. */
export function shQuote(value: string): string {
  if (value.includes("\0")) throw new SetupActionError("NUL in argument");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

function cocalc(args: string[]): string {
  return ['"$cocalc"', ...args.map(shQuote)].join(" ");
}

/** A script that prints an error and fails (for bad requests). */
export function errorScript(message: string): string {
  return `#!/bin/sh
printf '%s\\n' ${shQuote(`CoCalc: ${oneLine(message)}`)} >&2
exit 1
`;
}

function stepLines(step: SetupStep): string[] {
  const run = [
    ...(step.say ? [`say ${shQuote(oneLine(step.say))}`] : []),
    `${cocalc(step.args)} <"$tty"`,
  ];
  if (!step.unless) return run;
  return [
    `if ! ${cocalc(step.unless)} >/dev/null 2>&1; then`,
    ...run.map((line) => `  ${line}`),
    "fi",
  ];
}

export function setupScript(
  plan: SetupPlan,
  installer = CLI_INSTALLER_URL,
): string {
  const steps = plan.steps.flatMap(stepLines).join("\n");
  if (!plan.probe.every((word) => /^[a-z][a-z0-9-]*$/.test(word))) {
    throw new SetupActionError("probe words must be plain subcommand names");
  }
  const probe = plan.probe.join(" ");
  const done = plan.done ? `say ${shQuote(oneLine(plan.done))}` : "";
  return `#!/bin/sh
# CoCalc: ${oneLine(plan.title)}
# Uses the cocalc command line, installing or upgrading it first if needed
# (it asks you before doing that).
set -eu

# Prompts use the terminal: this script itself arrives on stdin.
tty=\${COCALC_SETUP_TTY:-/dev/tty}

say() { printf '%s\\n' "$*"; }

ask() {
  printf '%s [Y/n] ' "$1" >>"$tty"
  answer=
  read -r answer <"$tty" || answer=n
  case "$answer" in
    "" | [Yy] | [Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

# Every cocalc we can find, one per line: on PATH, and where the installer
# puts it (not necessarily on PATH in this shell yet).
candidates() {
  command -v cocalc 2>/dev/null || true
  printf '%s\\n' "\${XDG_BIN_HOME:-$HOME/.local/bin}/cocalc" \\
    "$HOME/.local/bin/cocalc" /usr/local/bin/cocalc
}

# New enough for this: its help for the subcommand is that subcommand's own
# ("Usage: cocalc ${probe} ..."), not the general help an old one prints.
works() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  usage=$("$1" ${probe} --help 2>/dev/null | grep -m 1 '^Usage:') || return 1
  case "$usage " in
    *" ${probe} "*) return 0 ;;
    *) return 1 ;;
  esac
}

# The first cocalc that works (pick), or that exists at all (any).
pick() {
  candidates | while IFS= read -r c; do
    if works "$c"; then
      printf '%s\\n' "$c"
      exit 0
    fi
  done
}
any() {
  candidates | while IFS= read -r c; do
    if [ -n "$c" ] && [ -x "$c" ]; then
      printf '%s\\n' "$c"
      exit 0
    fi
  done
}

cocalc=$(pick)
if [ -z "$cocalc" ]; then
  old=$(any)
  if [ -z "$old" ]; then
    question="This needs the CoCalc command line (cocalc), which isn't installed. Install it now?"
  else
    question="Your cocalc ($old) is too old for this. Upgrade it now?"
  fi
  if ! ask "$question"; then
    say "Nothing was changed. Install it with:"
    say ${shQuote(`  curl -fsSL ${installer} | bash`)}
    say "then run this line again."
    exit 1
  fi
  curl -fsSL ${shQuote(installer)} | bash
  # An old cocalc may still come first on PATH: take the one that works.
  cocalc=$(pick)
  if [ -z "$cocalc" ]; then
    say "cocalc is installed, but this version can't do this yet. Please try again later."
    exit 1
  fi
fi

${steps}
${done}
`;
}

/** SSH to a project: sign in to the site if needed, then configure SSH. */
export function sshPlan(site: string, project_id: string): SetupPlan {
  if (!isValidUUID(project_id)) {
    throw new SetupActionError("that isn't a project id");
  }
  const api = ["--api", site];
  return {
    title: `set up SSH to project ${project_id}`,
    probe: ["project", "ssh-config", "add"],
    steps: [
      {
        say: `Signing in to ${site}: approve it in your browser.`,
        args: [...api, "auth", "login"],
        unless: [...api, "auth", "status", "--check"],
      },
      { args: [...api, "project", "ssh-config", "add", "-w", project_id] },
    ],
    done: `Done. Connect with: ssh ${project_id}`,
  };
}
