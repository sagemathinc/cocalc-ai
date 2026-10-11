/*
Read a watched file's contents without following a symlink at the final path
component, without blocking on a special file, and optionally only if the
opened inode resolves inside a given sandbox base.

The sync-fs watcher and the low-level file watcher re-read a path after an
inotify event to compute a patch. A project user owns the files under their
own home, so between arming the watcher and this read they can replace a
watched regular file with:

  - a symlink pointing outside the sandbox, whose target would then be read
    into the collaborative document (a cross-project/content disclosure, since
    project-host shares a uid with every project it serves); or
  - a FIFO, whose blocking open would pin a libuv worker shared by every
    project in the process.

O_NOFOLLOW makes a swapped-in leaf symlink fail with ELOOP instead of being
followed, and O_NONBLOCK plus a regular-file check makes a FIFO return
immediately. O_NOFOLLOW only constrains the final component, so when a
containmentBase is given we additionally resolve the opened descriptor through
/proc/self/fd and refuse to read unless it lies inside that base. That closes a
parent-directory component being swapped to an outside symlink too, using the
same fd-anchored check the sandbox applies to its own reads and writes.
*/

import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, isAbsolute, sep } from "node:path";

function isInside(child: string, base: string): boolean {
  if (child === base) {
    return true;
  }
  const rel = relative(base, child);
  // Only a leading ".." component leaves the base; names such as "..hidden"
  // are ordinary entries inside it.
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

export async function readWatchedFileUtf8(
  path: string,
  containmentBase?: string,
): Promise<string> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      const err: NodeJS.ErrnoException = new Error(
        `EINVAL: refusing to read non-regular watched file '${path}'`,
      );
      err.code = "EINVAL";
      err.path = path;
      throw err;
    }
    if (containmentBase != null) {
      const resolved = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!isInside(resolved, containmentBase)) {
        const err: NodeJS.ErrnoException = new Error(
          `EACCES: watched file '${path}' resolves to a path outside of sandbox`,
        );
        err.code = "EACCES";
        err.path = path;
        throw err;
      }
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
