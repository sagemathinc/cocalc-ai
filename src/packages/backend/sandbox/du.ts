import exec, { type ExecOutput, validate } from "./exec";
import { type DuOptions } from "@cocalc/conat/files/fs";
export { type DuOptions };
import { existsSync } from "node:fs";

const duCmd = existsSync("/usr/bin/du") ? "/usr/bin/du" : "/bin/du";

export default async function du(
  path: string,
  { options, darwin, linux, timeout, maxSize }: DuOptions = {},
): Promise<ExecOutput> {
  if (path == null) {
    throw Error("path must be specified");
  }
  return await exec({
    cmd: duCmd,
    positionalArgs: [path],
    options,
    darwin,
    linux,
    maxSize,
    timeout,
    whitelist,
  });
}

const whitelist = {
  "--bytes": true,
  "-b": true,

  "--block-size": validate.int,
  "-B": validate.int,

  "--summarize": true,
  "-s": true,

  "--max-depth": validate.int,
  "-d": validate.int,

  "--one-file-system": true,
  "-x": true,

  "--all": true,
  "-a": true,

  "--help": true,
  "--version": true,
} as const;
