/*

NOTE: fd is a very fast parallel rust program for finding files matching
a pattern.  It is complementary to find here though, because we mainly
use find to compute directory
listing info (e.g., file size, mtime, etc.), and fd does NOT do that; it can
exec ls, but that is slower than using find.  So both find and fd are useful
for different tasks -- find is *better* for directory listings and fd is better
for finding filesnames in a directory tree that match a pattern.
*/

import type { FindOptions } from "@cocalc/conat/files/fs";
export type { FindOptions };
import exec, { type ExecOutput, validate } from "./exec";
import { platform } from "node:os";
import { basename } from "node:path";

export default async function find(
  path: string,
  { options, darwin, linux, timeout, maxSize }: FindOptions,
): Promise<ExecOutput> {
  if (path == null) {
    throw Error("path must be specified");
  }
  let selectedOptions = options ?? [];
  let printfFormat: string | undefined;
  if (platform() === "darwin") {
    ({ options: selectedOptions, printfFormat } = rewriteDarwinPrintf(
      selectedOptions,
    ));
  }
  const output = await exec({
    cmd: "find",
    cwd: path,
    prefixArgs: [path ? path : "."],
    options: selectedOptions,
    darwin,
    linux,
    maxSize,
    timeout,
    whitelist,
    safety: [],
  });
  if (printfFormat == null) {
    return output;
  }
  return applyPrintfProjection(output, path, printfFormat);
}

function rewriteDarwinPrintf(options: string[]): {
  options: string[];
  printfFormat?: string;
} {
  const rewritten: string[] = [];
  let printfFormat: string | undefined;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (opt === "-printf") {
      const format = options[i + 1];
      if (format == null) {
        throw Error("Option -printf requires a value");
      }
      if (format !== "%f\n" && format !== "%P\n") {
        throw Error(`Unsupported -printf format on darwin: ${format}`);
      }
      printfFormat = format;
      i += 1;
      continue;
    }
    rewritten.push(opt);
  }
  if (printfFormat != null) {
    rewritten.push("-print");
  }
  return { options: rewritten, printfFormat };
}

function applyPrintfProjection(
  output: ExecOutput,
  rootPath: string,
  printfFormat: string,
): ExecOutput {
  const root = rootPath === "" ? "." : rootPath;
  const text = Buffer.from(output.stdout).toString("utf8");
  const inputLines = text.split(/\r?\n/g).filter((line) => line.length > 0);
  const lines = inputLines.map((line) => {
    if (printfFormat === "%f\n") {
      return basename(line);
    }
    if (line === root) {
      return "";
    }
    if (line.startsWith(root + "/")) {
      return line.slice(root.length + 1);
    }
    return line;
  });
  const projected =
    lines.length === 0 ? "" : lines.filter((line) => line.length > 0).join("\n") + "\n";
  return { ...output, stdout: Buffer.from(projected) };
}

const whitelist = {
  // POSITIONAL OPTIONS
  "-daystart": true,
  "-regextype": validate.str,
  "-warn": true,
  "-nowarn": true,

  // GLOBAL OPTIONS
  "-d": true,
  "-depth": true,
  "--help": true,
  "-ignore_readdir_race": true,
  "-maxdepth": validate.int,
  "-mindepth": validate.int,
  "-mount": true,
  "-noignore_readdir_race": true,
  "--version": true,
  "-xdev": true,

  // TESTS
  "-amin": validate.float,
  "-anewer": validate.relativePath,
  "-atime": validate.float,
  "-cmin": validate.float,
  "-cnewer": validate.relativePath,
  "-ctime": validate.float,
  "-empty": true,
  "-executable": true,
  "-fstype": validate.str,
  "-gid": validate.int,
  "-group": validate.str,
  "-ilname": validate.str,
  "-iname": validate.str,
  "-inum": validate.int,
  "-ipath": validate.str,
  "-iregex": validate.str,
  "-iwholename": validate.str,
  "-links": validate.int,
  "-lname": validate.str,
  "-mmin": validate.int,
  "-mtime": validate.int,
  "-name": validate.str,
  "-newer": validate.relativePath,
  "-newerXY": validate.str,
  "-nogroup": true,
  "-nouser": true,
  "-path": validate.str,
  "-perm": validate.str,
  "-readable": true,
  "-regex": validate.str,
  "-samefile": validate.relativePath,
  "-size": validate.str,
  "-true": true,
  "-type": validate.str,
  "-uid": validate.int,
  "-used": validate.float,
  "-user": validate.str,
  "-wholename": validate.str,
  "-writable": true,
  "-xtype": validate.str,
  "-context": validate.str,

  // ACTIONS: obviously many are not whitelisted!
  "-ls": true,
  "-print": true,
  "-print0": true,
  "-printf": validate.str,
  "-prune": true,
  "-quit": true,

  // OPERATORS
  "(": true,
  ")": true,
  "!": true,
  "-not": true,
  "-a": true,
  "-and": true,
  "-o": true,
  "-or": true,
  ",": true,
} as const;
