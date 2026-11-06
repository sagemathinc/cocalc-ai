/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The rootfs agent: the program project-host runs inside a project's
container, as the project user, to do file operations on the project's
rootfs (see spawn.ts for how, protocol.ts for the wire format).

It is plain JavaScript using only Node's standard library, passed to the
bundle's node with `node -e`: the code comes from project-host's build, the
interpreter from a read-only host mount, nothing from the project's rootfs.
Inside the container it has exactly the project user's authority, so it
needs no sandboxing of its own; it still validates paths and bounds what it
reads and lists, and writes files through a temp file and a rename, so the
host's caps and contracts hold. The host trusts none of its answers.

Frames: 4-byte big-endian length, then a type byte (1 = JSON, 2 = chunk) and
the payload; a chunk's payload starts with its request's 4-byte id. The
agent exits when its stdin ends, and on any protocol error.
*/

export const ROOTFS_AGENT_VERSION = 1;

export const ROOTFS_AGENT_CODE = String.raw`"use strict";
const fs = require("node:fs");
const fsp = fs.promises;
const MAX_FRAME = 16 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const MAX_TREE_ENTRIES = 1000000;
const MAX_PATH = 4096;
const MAX_COMPONENT = 255;
const out = process.stdout;

function frame(type, payload) {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length + 1, 0);
  header.writeUInt8(type, 4);
  out.write(Buffer.concat([header, payload]));
}
function send(value) {
  frame(1, Buffer.from(JSON.stringify(value), "utf8"));
}
function chunk(id, data) {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(id, 0);
  frame(2, Buffer.concat([prefix, data]));
}
function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}
function checkPath(p) {
  if (typeof p !== "string" || p[0] !== "/" || p.includes("\0")) {
    throw fail("EINVAL", "not an absolute path");
  }
  if (Buffer.byteLength(p) > MAX_PATH) throw fail("ENAMETOOLONG");
  if (p === "/") return p;
  for (const part of p.slice(1).split("/")) {
    if (part === "" || part === "." || part === "..") {
      throw fail("EINVAL", "not a normalized path");
    }
    if (Buffer.byteLength(part) > MAX_COMPONENT) throw fail("ENAMETOOLONG");
  }
  return p;
}
function kind(st) {
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "dir";
  if (st.isSymbolicLink()) return "symlink";
  return "other";
}
function statResult(st) {
  return {
    type: kind(st),
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    mtimeMs: st.mtimeMs,
    atimeMs: st.atimeMs,
    ctimeMs: st.ctimeMs,
    nlink: st.nlink,
    ino: st.ino,
  };
}
function direntKind(d) {
  if (d.isFile()) return "file";
  if (d.isDirectory()) return "dir";
  if (d.isSymbolicLink()) return "symlink";
  return "other";
}
function int(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) throw fail("EINVAL", "bad " + name);
  return v;
}

// Removes a tree without following symlinks, bounded in entries.
async function removeTree(p, budget) {
  const st = await fsp.lstat(p);
  if (--budget.left < 0) throw fail("E2BIG", "too many entries");
  if (st.isDirectory()) {
    for (const name of await fsp.readdir(p)) {
      await removeTree(p + "/" + name, budget);
    }
    await fsp.rmdir(p);
  } else {
    await fsp.unlink(p);
  }
}

const writes = new Map();

async function handle(req) {
  const id = req.id;
  const op = req.op;
  switch (op) {
    case "stat":
      return statResult(await fsp.stat(checkPath(req.path)));
    case "lstat":
      return statResult(await fsp.lstat(checkPath(req.path)));
    case "readdir": {
      const dir = await fsp.opendir(checkPath(req.path));
      const entries = [];
      let truncated = false;
      for await (const d of dir) {
        if (entries.length >= MAX_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push({ name: d.name, type: direntKind(d) });
      }
      if (truncated) await dir.close().catch(() => {});
      return { entries: entries, truncated: truncated };
    }
    case "readlink":
      return await fsp.readlink(checkPath(req.path));
    case "realpath":
      return await fsp.realpath(checkPath(req.path));
    case "mkdir":
      await fsp.mkdir(checkPath(req.path), {
        recursive: req.recursive === true,
        mode: req.mode == null ? 0o777 : int(req.mode, "mode") & 0o7777,
      });
      return null;
    case "rmdir":
      await fsp.rmdir(checkPath(req.path));
      return null;
    case "unlink":
      await fsp.unlink(checkPath(req.path));
      return null;
    case "rm": {
      const p = checkPath(req.path);
      if (p === "/") throw fail("EPERM", "not the root");
      try {
        if (req.recursive === true) {
          await removeTree(p, { left: MAX_TREE_ENTRIES });
        } else {
          await fsp.unlink(p);
        }
      } catch (err) {
        if (!(req.force === true && err.code === "ENOENT")) throw err;
      }
      return null;
    }
    case "rename":
      await fsp.rename(checkPath(req.path), checkPath(req.dest));
      return null;
    case "chmod":
      await fsp.chmod(checkPath(req.path), int(req.mode, "mode") & 0o7777);
      return null;
    case "utimes":
      await fsp.utimes(
        checkPath(req.path),
        int(req.atime, "atime"),
        int(req.mtime, "mtime"),
      );
      return null;
    case "readFile": {
      const fh = await fsp.open(checkPath(req.path), "r");
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw fail("EISDIR", "not a regular file");
        if (st.size > MAX_FILE) throw fail("EFBIG", "file too large");
        const size = st.size;
        const buf = Buffer.alloc(Math.min(CHUNK, Math.max(size, 1)));
        const parts = [];
        let read = 0;
        while (read < size) {
          const r = await fh.read(buf, 0, Math.min(buf.length, size - read), read);
          if (r.bytesRead === 0) break;
          parts.push(Buffer.from(buf.subarray(0, r.bytesRead)));
          read += r.bytesRead;
        }
        send({ id: id, ok: true, result: { size: read } });
        for (const part of parts) chunk(id, part);
        return undefined;
      } finally {
        await fh.close().catch(() => {});
      }
    }
    default:
      throw fail("ENOSYS", "unknown operation");
  }
}

// The parent directory of an absolute path, opened one component at a time
// from "/" with O_DIRECTORY|O_NOFOLLOW, each relative to the previous one's
// fd (through /proc/self/fd/<fd>/<name>, which resolves from that fd as
// openat does): a symlink anywhere on the way is refused, and a directory
// swapped later doesn't move the result.
const DIR_FLAGS =
  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
function at(fd, name) {
  return "/proc/self/fd/" + fd + "/" + name;
}
async function openParent(p) {
  const parts = p.slice(1).split("/");
  const name = parts.pop();
  let dir = await fsp.open("/", DIR_FLAGS);
  try {
    for (const part of parts) {
      const next = await fsp.open(at(dir.fd, part), DIR_FLAGS);
      await dir.close();
      dir = next;
    }
  } catch (err) {
    await dir.close().catch(() => {});
    throw err;
  }
  return { dir: dir, name: name };
}

// A write is registered when its request arrives, before anything async, so
// its data chunks (sent right behind it) always find it. A write that fails
// still consumes its declared bytes, then replies with the error.
function startWrite(req) {
  const id = req.id;
  const size = req.size;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) {
    return reply(id, fail("EFBIG", "bad size"));
  }
  const w = { left: size, failed: null, fh: null, tmp: null, dir: null, name: null };
  writes.set(id, w);
  w.chain = (async () => {
    const p = checkPath(req.path);
    if (p === "/") throw fail("EISDIR");
    const parent = await openParent(p);
    w.dir = parent.dir;
    w.name = parent.name;
    w.tmp = ".cocalc-write-" + process.pid + "-" + id + "-" + w.name.slice(0, 64);
    w.fh = await fsp.open(
      at(w.dir.fd, w.tmp),
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      req.mode == null ? 0o666 : int(req.mode, "mode") & 0o7777,
    );
  })().catch((err) => {
    w.failed = err;
  });
  if (size === 0) w.chain = w.chain.then(() => finishWrite(id, w));
}

async function finishWrite(id, w) {
  writes.delete(id);
  try {
    if (w.failed) throw w.failed;
    await w.fh.close();
    w.fh = null;
    // both names under the verified directory's fd: renameat
    await fsp.rename(at(w.dir.fd, w.tmp), at(w.dir.fd, w.name));
    w.tmp = null;
    send({ id: id, ok: true, result: null });
  } catch (err) {
    reply(id, err);
  } finally {
    await cleanupWrite(w);
  }
}

function reply(id, err) {
  send({
    id: id,
    ok: false,
    error: {
      code: typeof err.code === "string" ? err.code.slice(0, 32) : "EIO",
      message: String(err.message || err).slice(0, 200),
    },
  });
}

async function cleanupWrite(w) {
  if (w.fh) await w.fh.close().catch(() => {});
  w.fh = null;
  if (w.dir && w.tmp) await fsp.unlink(at(w.dir.fd, w.tmp)).catch(() => {});
  w.tmp = null;
  if (w.dir) await w.dir.close().catch(() => {});
  w.dir = null;
}

async function abortWrites() {
  for (const [id, w] of writes) {
    writes.delete(id);
    await w.chain.catch(() => {});
    await cleanupWrite(w);
  }
}

function onChunk(id, data) {
  const w = writes.get(id);
  if (!w || data.length > w.left) return protocolError();
  w.left -= data.length;
  const last = w.left === 0;
  w.chain = w.chain
    .then(async () => {
      if (!w.failed) await w.fh.write(data);
    })
    .catch((err) => {
      w.failed = w.failed || err;
    })
    .then(() => (last ? finishWrite(id, w) : undefined));
}

function onRequest(req) {
  if (req == null || typeof req !== "object" || !Number.isSafeInteger(req.id)) {
    return protocolError("bad request");
  }
  if (req.op === "writeFile") return startWrite(req);
  handle(req).then(
    (result) => {
      if (result !== undefined) send({ id: req.id, ok: true, result: result });
    },
    (err) => reply(req.id, err),
  );
}

let buffered = Buffer.alloc(0);
let dead = false;
function protocolError() {
  if (dead) return;
  dead = true;
  abortWrites().finally(() => process.exit(2));
}
process.stdin.on("data", (data) => {
  if (dead) return;
  buffered = Buffer.concat([buffered, data]);
  if (buffered.length > MAX_FRAME + 5) return protocolError();
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (length < 1 || length > MAX_FRAME) return protocolError();
    if (buffered.length < 4 + length) break;
    const type = buffered.readUInt8(4);
    const payload = buffered.subarray(5, 4 + length);
    buffered = buffered.subarray(4 + length);
    if (type === 1) {
      let req;
      try {
        req = JSON.parse(payload.toString("utf8"));
      } catch (err) {
        return protocolError();
      }
      onRequest(req);
    } else if (type === 2 && payload.length >= 4) {
      onChunk(payload.readUInt32BE(0), Buffer.from(payload.subarray(4)));
    } else {
      return protocolError();
    }
  }
});
process.stdin.on("end", () => {
  abortWrites().finally(() => process.exit(0));
});
send({
  type: "hello",
  version: VERSION,
  pid: process.pid,
});
`.replace("VERSION", `${ROOTFS_AGENT_VERSION}`);
