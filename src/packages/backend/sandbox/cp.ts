/*
Implement cp with same API as node, but using a spawned subprocess, because
Node's cp does NOT have reflink support, but we very much want it to get
the full benefit of btrfs's copy-on-write functionality.
*/

import exec from "./exec";
import { type CopyOptions } from "@cocalc/conat/files/fs";
export { type CopyOptions };
import { exists } from "./install";

// Copying is bounded by the caller's own operation. A short exec default would
// kill large copies part way through: cloning a file that was just written
// first waits for btrfs to flush it, which can take many seconds.
const DEFAULT_CP_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export default async function cp(
  src: string[] | string,
  dest: string,
  options: CopyOptions = {},
): Promise<void> {
  const args: string[] = [];
  if (typeof src == "string") {
    args.push("-T", src);
    // Why the -T?  When the src is string instead of an array,
    // we maintain the
    // cp semantics of ndoejs, where always dest is exactly what gets
    // created/written, **not a file in dest**.  E.g., if a is a directory,
    // then doing
    //    cp('a','b',{recursive:true})
    // twice is idempotent, whereas with /usr/bin/cp without the -T option,
    // then second call creates b/a.
  } else {
    args.push(...src);
  }
  args.push(dest);
  const opts: string[] = [];
  if (!options.dereference) {
    opts.push("-d");
  }
  if (!(options.force ?? true)) {
    // according to node docs, when force=true:
    //   "overwrite existing file or directory"
    // The -n (or --no-clobber) docs to cp: "do not overwrite an existing file",
    // so I think force=false is same as --update.
    if (options.errorOnExist) {
      // If moreover errorOnExist is set, then node's cp will also throw an error
      // with code "ERR_FS_CP_EEXIST"
      // SystemError [ERR_FS_CP_EEXIST]: Target already exists
      // /usr/bin/cp doesn't really have such an option, so we use exist directly.
      if (await exists(dest)) {
        const e = Error(
          "SystemError [ERR_FS_CP_EEXIST]: Target already exists",
        );
        // @ts-ignore
        e.code = "ERR_FS_CP_EEXIST";
        throw e;
      }
    }
    // silently does nothing if target exists
    opts.push("-n");
  } else {
    // Do not follow destination symlinks while overwriting.  This helper runs
    // on the host for some project-to-project copies, where a project-created
    // symlink may contain a path meaningful only in the host namespace.
    opts.push("--remove-destination");
  }

  if (options.preserveTimestamps) {
    opts.push("-p");
  }
  if (options.recursive) {
    opts.push("-r");
  }
  if (options.reflink) {
    opts.push("--reflink=auto");
  }

  const timeout = options.timeout ?? DEFAULT_CP_TIMEOUT_MS;
  const { code, stderr, truncated } = await exec({
    cmd: "/usr/bin/cp",
    safety: [...opts, ...args],
    timeout,
  });
  if (code) {
    // A killed cp leaves a partial copy; never report it as success.
    throw Error(
      `${stderr.toString().trim() || `cp exited with code ${code}`}${
        truncated ? ` (stopped after ${timeout} ms)` : ""
      }`,
    );
  }
}
