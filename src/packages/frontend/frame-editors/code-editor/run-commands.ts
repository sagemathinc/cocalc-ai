/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Running a code file in a terminal: the per-extension command templates and the
pure command builder.

This module deliberately imports nothing but @cocalc/util, so the command
registry, the editor actions and the CodeMirror keybindings can all use it
without pulling in the code editor component (and the import cycle that comes
with it).
*/

import { filename_extension, path_split } from "@cocalc/util/misc";
import { projectRuntimeHomeRelativePath } from "@cocalc/util/project-runtime";

// Maps file extensions to run commands.  Keys are lowercase, since the lookup
// falls back to the lowercased extension; the one exception is "C", which is
// C++ by convention and has to win over "c" before that fallback.
// {file} = basename (e.g. "hello.c"), {name} = basename without extension
// (e.g. "hello").  Both are shell-escaped when substituted.
export const RUN_COMMANDS: { [ext: string]: string } = {
  py: "python3 {file}",
  sage: "sage {file}",
  r: "Rscript {file}",
  jl: "julia {file}",
  js: "node {file}",
  ts: "ts-node {file}",
  rb: "ruby {file}",
  sh: "bash {file}",
  bash: "bash {file}",
  pl: "perl {file}",
  lua: "lua {file}",
  m: "octave {file}",
  go: "go run {file}",
  c: "gcc {file} -o ./{name} && ./{name}",
  cpp: "g++ {file} -o ./{name} && ./{name}",
  cc: "g++ {file} -o ./{name} && ./{name}",
  // ".C" is C++ by convention.  gcc would compile it as C++ but not link the
  // C++ standard library, so an iostream program fails to link.
  C: "g++ {file} -o ./{name} && ./{name}",
  java: "javac {file} && java {name}",
  rs: "rustc {file} -o ./{name} && ./{name}",
} as const;

export function runCommandTemplate(path: string): string | undefined {
  const ext = filename_extension(path);
  // Exact case first, so ".C" gets g++ rather than the "c" entry's gcc, then
  // case insensitively, so that both "foo.r" and "foo.R" run with Rscript.
  return RUN_COMMANDS[ext] ?? RUN_COMMANDS[ext.toLowerCase()];
}

// Whether the Run button/command applies to this file at all.
export function canRunFile(path: string): boolean {
  return runCommandTemplate(path) != null;
}

// Quote for bash: wrap in single quotes and escape any single quote.
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// The file to run, as an argument.  Quoting stops the shell from splitting or
// expanding it, but not the interpreter from reading a leading dash as an
// option -- "python3 '-report.py'" fails with "Unknown option: -r".  Naming it
// as a path fixes that, and we always cd to its directory first, so "./" is
// the right prefix.
function fileArg(file: string): string {
  return shellEscape(file.startsWith("-") ? `./${file}` : file);
}

// Where to cd to before running.  Editor paths are relative to the project's
// HOME, so they must be anchored there: a fresh terminal frame for
// "dir/foo.py" already starts in "dir" (its cwd is the dirname of the editor's
// path), so a relative "cd dir" would look for "dir/dir".  A terminal we reuse
// can be anywhere at all, which is why we always cd, even for a file in HOME.
function cdTarget(dir: string): string {
  // Launchpad exposes project files under the canonical /home/user (and older
  // sessions may use /root), but a local project terminal can have a different
  // concrete HOME. Map those runtime-home aliases back through $HOME so the
  // command runs in the terminal's actual filesystem.
  const runtimeHomeRelative = projectRuntimeHomeRelativePath(dir);
  if (runtimeHomeRelative != null) {
    return runtimeHomeRelative
      ? `"$HOME"/${shellEscape(runtimeHomeRelative)}`
      : `"$HOME"`;
  }
  if (dir.startsWith("/")) {
    // absolute path -- rare, but then HOME is not the right anchor
    return shellEscape(dir);
  }
  return dir ? `"$HOME"/${shellEscape(dir)}` : `"$HOME"`;
}

// The command that running `path` sends to the terminal, or undefined if we
// have no interpreter/compiler for this extension.
//
// With cd (the default) the command first changes to the file's directory, so
// it works no matter where the terminal happens to be.  Without it the bare
// command is returned, which is what we show the user in the tooltip.
export function buildRunCommand(
  path: string,
  { cd = true }: { cd?: boolean } = {},
): string | undefined {
  const template = runCommandTemplate(path);
  if (template == null) {
    return undefined;
  }
  const { head: dir, tail: file } = path_split(path);
  const name = file.replace(/\.[^.]+$/, "");
  // The replacements are functions so that a filename containing "$&" or "$'"
  // is not interpreted as a replacement pattern.
  const command = template
    .replace(/\{file\}/g, () => fileArg(file))
    .replace(/\{name\}/g, () => shellEscape(name));
  if (!cd) {
    return command;
  }
  return `cd -- ${cdTarget(dir)} && ${command}`;
}
