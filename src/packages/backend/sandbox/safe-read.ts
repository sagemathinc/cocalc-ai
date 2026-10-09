/*
Read a watched file's contents without following a symlink at the final path
component and without blocking on a special file.

The sync-fs watcher and the low-level file watcher re-read a path after an
inotify event to compute a patch. A project user owns the files under their
own home, so between arming the watcher and this read they can replace a
watched regular file with:

  - a symlink pointing outside the sandbox, whose target would then be read
    into the collaborative document (a cross-project/content disclosure, since
    project-host shares a uid with every project it serves); or
  - a FIFO, whose blocking open would pin a libuv worker shared by every
    project in the process.

O_NOFOLLOW makes the first case fail with ELOOP instead of following the link,
and O_NONBLOCK plus a regular-file check makes the second return immediately.
This only constrains the final component; full descriptor-anchored resolution
of the parent chain is handled separately by the openat2 sandbox.
*/

import { open } from "node:fs/promises";
import { constants } from "node:fs";

export async function readWatchedFileUtf8(path: string): Promise<string> {
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
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
