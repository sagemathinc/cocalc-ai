#!/usr/bin/env node
/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Escrow of a bay's configuration and secrets, sealed with the site master key.
//
// A bay's backups are useless without its configuration: /etc/cocalc/
// bay-secrets.env holds the pgBackRest cipher passphrase, the backup R2
// credentials and the SQLite repository password, and the bay secrets
// directory holds the project-host auth key pair, the project backup shared
// secret, the Conat password and the Cloudflare tunnel credentials. Only the
// site master key is kept off the bay (in 1Password). This file seals the rest
// with a key derived from that master key, so the copy kept next to the
// backups in R2 is all a restore needs besides the master key and read access
// to the bucket.
//
// The site master key together with an escrow is full-site root authority:
// it yields every credential the bay holds. See "Configuration Escrow" in the
// bay-systemd README.
//
// It runs as root over a tree the bay account can write, so it never follows
// a symbolic link: every path is opened one component at a time with
// O_NOFOLLOW, files are read and written through the descriptor that was
// checked, and new files are created with O_EXCL and renamed into place
// relative to their directory's descriptor. Sizes and counts are bounded while
// walking and before anything is decrypted. Linux only (/proc/self/fd).
//
// Built-ins only: it must run from a plain repository checkout on a fresh
// machine, with no install step. R2 transfers are done by the caller
// (bay-config-escrow-run, or curl --aws-sigv4 during a restore).
//
// Each included file belongs to a named root, e.g. etc-cocalc (/etc/cocalc)
// or bay-secrets (the bay SECRETS directory), and is stored by its path
// relative to that root, with its mode, owner and group. Directories under a
// root are recorded the same way, so a restore recreates them as they were.
//
// Usage:
//   seal   --master-key FILE --bay-id ID --out ESCROW --include ROOT=PATH...
//          [--exclude GLOB...]   (PATH is a file or a directory tree)
//   verify --master-key FILE --in ESCROW --include ROOT=PATH... [--exclude GLOB...]
//   open   --master-key FILE --in ESCROW (--out-dir DIR | --map ROOT=DIR...)
//          [--force] [--chown]
//   info   --in ESCROW [--master-key FILE]
//
// GLOB matches a path relative to its root: "*" stays within one path
// component and "**/" matches any number of leading directories. A matching
// directory is skipped entirely.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

export const ESCROW_KIND = "cocalc-bay-config-escrow";
export const ESCROW_VERSION = 1;
// Must match deriveSiteMasterKey(key, "bay-config-escrow:v1") in
// @cocalc/util/master-key-lifecycle.
export const ESCROW_PURPOSE = "bay-config-escrow:v1";
export const LIMITS = Object.freeze({
  fileBytes: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
  files: 256,
  dirs: 256,
  // Directory entries looked at while walking, including skipped ones.
  entries: 4096,
  depth: 16,
  // A sealed escrow of totalBytes is base64 encoded twice: about 7.2 MiB.
  envelopeBytes: 8 * 1024 * 1024,
});
const ROOT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const PATH_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/;
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,31}\$?$/;
// Not exported by node: open a path without opening the file itself, so
// nothing (a FIFO, a device) is touched before its type has been checked.
const O_PATH = constants.O_PATH ?? 0o10000000;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_DIRECTORY } =
  constants;

export function parseMasterKey(contents) {
  const key = Buffer.from(`${contents}`.trim(), "base64");
  if (key.length !== 32) {
    throw new Error("the site master key must be 32 bytes, base64 encoded");
  }
  return key;
}

export function deriveEscrowKey(masterKey) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      Buffer.from("cocalc-site-master-key:v1"),
      Buffer.from(`cocalc:${ESCROW_PURPOSE}`),
      32,
    ),
  );
}

// Identifies the master key that sealed an escrow without revealing anything
// usable about it, so `open` can say "wrong key" instead of "corrupt". It is
// the same for every escrow sealed with one site's key.
function keyCheck(escrowKey) {
  return createHmac("sha256", escrowKey)
    .update("cocalc-bay-config-escrow key check")
    .digest("base64")
    .slice(0, 22);
}

// Every envelope field outside the ciphertext, in a fixed order. All of it is
// authenticated: changing any of it makes `open` fail.
const HEADER_FIELDS = [
  "kind",
  "version",
  "bay_id",
  "created_at",
  "purpose",
  "key_check",
  "host",
];

function header(envelope) {
  return Buffer.from(
    JSON.stringify(HEADER_FIELDS.map((field) => envelope[field] ?? null)),
  );
}

/** A safe relative path: no absolute paths, "..", or empty components. */
export function checkRelativePath(path) {
  const parts = `${path}`.split("/");
  if (
    parts.length > LIMITS.depth ||
    parts.some((part) => !PATH_PART.test(part))
  ) {
    throw new Error(`invalid escrow path: ${JSON.stringify(path)}`);
  }
  return parts.join("/");
}

// The root directory itself is recorded with the path "".
function checkDirPath(path) {
  return path === "" ? "" : checkRelativePath(path);
}

function checkRoot(root) {
  if (!ROOT_NAME.test(`${root}`)) {
    throw new Error(`invalid escrow root: ${JSON.stringify(root)}`);
  }
  return root;
}

function checkMode(mode, what) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error(`invalid mode for ${what}`);
  }
  return mode;
}

function checkAccount(name, what) {
  if (name === null) return null;
  if (typeof name !== "string" || !ACCOUNT_NAME.test(name)) {
    throw new Error(`invalid owner or group for ${what}`);
  }
  return name;
}

export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      source += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      source += "[^/]*";
      i += 1;
    } else {
      source += glob[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

// Local accounts, from the files themselves rather than a subprocess.
function accounts(file) {
  const byId = new Map();
  const byName = new Map();
  let text = "";
  try {
    text = readSmallFile(file, 4 * 1024 * 1024).toString("utf8");
  } catch {
    // No such file: every lookup fails, which callers report.
  }
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    if (fields.length < 4) continue;
    const id = Number(fields[2]);
    if (!Number.isInteger(id)) continue;
    const entry = { name: fields[0], id, gid: Number(fields[3]) };
    if (!byId.has(id)) byId.set(id, entry);
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  return { byId, byName };
}

export const systemAccounts = () => ({
  users: accounts("/etc/passwd"),
  groups: accounts("/etc/group"),
});

// --- descriptor-based file system access ----------------------------------

const at = (dirFd, name) => `/proc/self/fd/${dirFd}/${name}`;
// The exact object an O_PATH descriptor refers to, for chmod/chown/reopen.
const self = (fd) => `/proc/self/fd/${fd}`;

function errorCode(err) {
  return err?.code;
}

/**
 * Open an absolute path one component at a time, refusing a symbolic link
 * anywhere in it. Returns an O_PATH descriptor of the final component, which
 * may itself be a symbolic link: callers check its type with fstat.
 */
function openNoFollow(path, { missingOk = false } = {}) {
  // missingOk: return undefined if any component is missing.
  const absolute = resolve(path);
  const parts = absolute.split("/").filter(Boolean);
  let fd = openSync("/", O_PATH | O_DIRECTORY);
  for (let i = 0; i < parts.length; i++) {
    let next;
    try {
      next = openSync(at(fd, parts[i]), O_PATH | O_NOFOLLOW);
    } catch (err) {
      closeSync(fd);
      if (missingOk && errorCode(err) === "ENOENT") {
        return undefined;
      }
      throw err;
    }
    closeSync(fd);
    fd = next;
    if (i < parts.length - 1 && !fstatSync(fd).isDirectory()) {
      closeSync(fd);
      throw new Error(
        `${absolute}: ${parts.slice(0, i + 1).join("/")} is not a directory (symbolic links are refused)`,
      );
    }
  }
  return fd;
}

// Read a regular file through a descriptor already checked with fstat.
function readChecked(pathFd, stat, limit, full) {
  if (stat.size > limit) {
    throw new Error(`escrow file too large (${stat.size} bytes): ${full}`);
  }
  // Reopening the O_PATH descriptor opens exactly the checked inode.
  const fd = openSync(self(pathFd), O_RDONLY);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) {
      throw new Error(`${full} changed while being read`);
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    const after = fstatSync(fd);
    if (
      length !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs
    ) {
      throw new Error(`${full} changed while being read; try again`);
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function readSmallFile(path, limit) {
  const fd = openNoFollow(path);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    return readChecked(fd, stat, limit, path);
  } finally {
    closeSync(fd);
  }
}

/**
 * Regular files and directories under each include, by root and relative
 * path. Symbolic links and other special files are refused rather than
 * followed; excluded entries are never opened.
 */
export function collect(includes, excludes = [], { system } = {}) {
  const patterns = excludes.map(globToRegExp);
  const excluded = (path) => patterns.some((pattern) => pattern.test(path));
  const { users, groups } = system ?? systemAccounts();
  const files = [];
  const dirs = [];
  let entries = 0;
  let bytes = 0;
  const metadata = (stat) => ({
    mode: stat.mode & 0o777,
    owner: users.byId.get(stat.uid)?.name ?? null,
    group: groups.byId.get(stat.gid)?.name ?? null,
  });
  const addFile = (root, path, fd, stat, full) => {
    if (!stat.isFile()) {
      throw new Error(`refusing to escrow a non-regular file: ${full}`);
    }
    if (files.length >= LIMITS.files) {
      throw new Error(`too many files to escrow (more than ${LIMITS.files})`);
    }
    const content = readChecked(fd, stat, LIMITS.fileBytes, full);
    bytes += content.length;
    if (bytes > LIMITS.totalBytes) {
      throw new Error(
        `too much data to escrow (more than ${LIMITS.totalBytes} bytes)`,
      );
    }
    files.push({
      root,
      path: checkRelativePath(path),
      ...metadata(stat),
      content,
    });
  };
  const walk = (root, dirFd, prefix, full, depth) => {
    if (depth > LIMITS.depth) throw new Error(`too deep: ${full}`);
    if (dirs.length >= LIMITS.dirs) {
      throw new Error(`too many directories to escrow: ${full}`);
    }
    dirs.push({
      root,
      path: prefix === "" ? "" : checkRelativePath(prefix),
      ...metadata(fstatSync(dirFd)),
    });
    const names = readdirSync(self(dirFd)).sort();
    entries += names.length;
    if (entries > LIMITS.entries) {
      throw new Error(`too many directory entries under ${full}`);
    }
    for (const name of names) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (excluded(path)) continue;
      const entryFull = `${full}/${name}`;
      const fd = openSync(at(dirFd, name), O_PATH | O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (stat.isDirectory()) walk(root, fd, path, entryFull, depth + 1);
        else addFile(root, path, fd, stat, entryFull);
      } finally {
        closeSync(fd);
      }
    }
  };
  for (const { root, path } of includes) {
    checkRoot(root);
    const fd = openNoFollow(path);
    try {
      const stat = fstatSync(fd);
      if (stat.isDirectory()) walk(root, fd, "", resolve(path), 0);
      else if (!excluded(basename(path))) {
        addFile(root, basename(path), fd, stat, resolve(path));
      }
    } finally {
      closeSync(fd);
    }
  }
  const seen = new Set();
  for (const { root, path } of [...files, ...dirs]) {
    const key = `${root}/${path}`;
    if (seen.has(key)) throw new Error(`duplicate escrow path: ${key}`);
    seen.add(key);
  }
  return { files, dirs };
}

// --- sealing and opening --------------------------------------------------

export function seal({
  masterKey,
  bayId,
  files,
  dirs = [],
  now = new Date(),
  host = hostname(),
}) {
  if (!bayId || !/^[A-Za-z0-9._-]{1,64}$/.test(bayId)) {
    throw new Error("invalid bay id");
  }
  const escrowKey = deriveEscrowKey(masterKey);
  const envelope = {
    kind: ESCROW_KIND,
    version: ESCROW_VERSION,
    bay_id: bayId,
    created_at: now.toISOString(),
    purpose: ESCROW_PURPOSE,
    key_check: keyCheck(escrowKey),
    host: `${host}`.slice(0, 253),
  };
  const payload = checkPayload({
    files: files.map(({ root, path, mode, owner, group, content }) => ({
      root,
      path,
      mode,
      owner: owner ?? null,
      group: group ?? null,
      sha256: createHash("sha256").update(content).digest("hex"),
      content: content.toString("base64"),
    })),
    dirs: dirs.map(({ root, path, mode, owner, group }) => ({
      root,
      path,
      mode,
      owner: owner ?? null,
      group: group ?? null,
    })),
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", escrowKey, iv);
  cipher.setAAD(header(envelope));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  // File names stay inside the ciphertext: the envelope does not list the
  // bay's secrets.
  return {
    ...envelope,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Validate a decrypted payload before anything is written: shape, counts,
 * names, modes, sizes, checksums, unique paths, and no file standing where
 * another entry needs a directory. Returns it with contents decoded.
 */
export function checkPayload(payload, { decode = false } = {}) {
  const files = payload?.files;
  const dirs = payload?.dirs ?? [];
  if (!Array.isArray(files) || !Array.isArray(dirs)) {
    throw new Error("escrow payload is malformed");
  }
  if (files.length > LIMITS.files || dirs.length > LIMITS.dirs) {
    throw new Error("escrow payload has too many entries");
  }
  const kinds = new Map();
  const claim = (key, kind) => {
    if (kinds.has(key)) throw new Error(`duplicate escrow path: ${key}`);
    kinds.set(key, kind);
  };
  const checkedDirs = dirs.map((dir) => {
    const root = checkRoot(dir?.root);
    const path = checkDirPath(dir?.path);
    const what = `${root}/${path}`;
    claim(what, "dir");
    return {
      root,
      path,
      mode: checkMode(dir.mode, what),
      owner: checkAccount(dir.owner ?? null, what),
      group: checkAccount(dir.group ?? null, what),
    };
  });
  let total = 0;
  const checkedFiles = files.map((file) => {
    const root = checkRoot(file?.root);
    const path = checkRelativePath(file?.path);
    const what = `${root}/${path}`;
    claim(what, "file");
    if (
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      typeof file.content !== "string" ||
      file.content.length > Math.ceil(LIMITS.fileBytes / 3) * 4
    ) {
      throw new Error(`escrow file ${what} is malformed`);
    }
    const checked = {
      root,
      path,
      mode: checkMode(file.mode, what),
      owner: checkAccount(file.owner ?? null, what),
      group: checkAccount(file.group ?? null, what),
      sha256: file.sha256,
      content: file.content,
    };
    if (decode) {
      const data = Buffer.from(file.content, "base64");
      if (data.length > LIMITS.fileBytes) {
        throw new Error(`escrow file ${what} is too large`);
      }
      total += data.length;
      if (createHash("sha256").update(data).digest("hex") !== file.sha256) {
        throw new Error(`escrow file ${what} failed its checksum`);
      }
      checked.content = data;
      delete checked.sha256;
    }
    return checked;
  });
  if (total > LIMITS.totalBytes) throw new Error("escrow payload is too large");
  for (const [key] of kinds) {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (kinds.get(ancestor) === "file") {
        throw new Error(`escrow path ${key} is below the file ${ancestor}`);
      }
    }
  }
  return { files: checkedFiles, dirs: checkedDirs };
}

function checkEnvelope(envelope) {
  if (envelope?.kind !== ESCROW_KIND || envelope.version !== ESCROW_VERSION) {
    throw new Error("not a CoCalc bay configuration escrow (version 1)");
  }
  for (const field of ["iv", "tag", "ciphertext", "key_check"]) {
    if (typeof envelope[field] !== "string") {
      throw new Error(`escrow envelope is missing ${field}`);
    }
  }
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("escrow envelope has an invalid iv or tag");
  }
  return { iv, tag };
}

export function open({ masterKey, envelope }) {
  const { iv, tag } = checkEnvelope(envelope);
  const escrowKey = deriveEscrowKey(masterKey);
  if (envelope.key_check !== keyCheck(escrowKey)) {
    throw new Error(
      "this escrow was sealed with a different site master key; use the site master key of the site being restored",
    );
  }
  const decipher = createDecipheriv("aes-256-gcm", escrowKey, iv, {
    authTagLength: 16,
  });
  decipher.setAAD(header(envelope));
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new Error(
      "escrow authentication failed: the escrow is corrupt or was modified",
    );
  }
  return checkPayload(JSON.parse(plaintext.toString("utf8")), {
    decode: true,
  });
}

export function readEnvelope(path) {
  // O_NONBLOCK: a FIFO in place of the escrow fails the check below instead
  // of blocking.
  const fd = openSync(path, O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMITS.envelopeBytes) {
      throw new Error(
        `${path} is not an escrow (not a regular file of at most ${LIMITS.envelopeBytes} bytes)`,
      );
    }
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

// --- restoring ------------------------------------------------------------

function ids(owner, group, system, what) {
  const user = owner ? system.users.byName.get(owner) : undefined;
  const grp = group ? system.groups.byName.get(group) : undefined;
  if (!user) {
    throw new Error(
      `--chown: owner ${JSON.stringify(owner)} of ${what} is not a local user; create it first`,
    );
  }
  if (group && !grp) {
    throw new Error(
      `--chown: group ${JSON.stringify(group)} of ${what} is not a local group; create it first`,
    );
  }
  return { uid: user.id, gid: grp ? grp.id : user.gid };
}

function createExclusive(
  dirFd,
  name,
  content,
  mode,
  owner,
  fchown = fchownSync,
) {
  const temporary = `.${name}.escrow-${randomBytes(6).toString("hex")}`;
  const fd = openSync(
    at(dirFd, temporary),
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
    0o600,
  );
  try {
    let written = 0;
    while (written < content.length) {
      written += writeSync(fd, content, written, content.length - written);
    }
    if (owner) fchown(fd, owner.uid, owner.gid);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    unlinkSync(at(dirFd, temporary));
    throw err;
  }
  closeSync(fd);
  // rename() replaces a link at the destination rather than following it.
  renameSync(at(dirFd, temporary), at(dirFd, name));
}

/**
 * Write the escrowed directories and files below their mapped directories.
 * The whole destination plan is checked before anything is written: no two
 * entries (from any root) may land on the same path, and no file may stand
 * where another entry needs a directory. No symbolic link is followed, in the
 * destination or any of its components; existing files are replaced only
 * with `force`. With `chown` (root only) files and the directories this
 * restore creates get their recorded owner, group and mode; existing
 * directories are left as they are.
 */
export function restore({ files, dirs }, bases, options = {}) {
  const { force = false, chown = false } = options;
  const system = options.system ?? systemAccounts();
  // Injectable for tests that do not run as root.
  const getuid = options.getuid ?? (() => process.getuid());
  const fchown = options.fchown ?? fchownSync;
  const pathChown = options.pathChown ?? chownSync;
  if (chown && getuid() !== 0) {
    throw new Error("--chown must be run as root");
  }
  const baseOf = (root) => {
    const base = bases.get(root);
    if (!base) {
      throw new Error(`no destination for root ${root}; add --map ${root}=DIR`);
    }
    return resolve(base);
  };
  // Canonical, so the plan below sees "/" + "x" and "/x" as one path.
  const fullPath = ({ root, path }) =>
    path ? resolve(baseOf(root), path) : baseOf(root);
  // --out-dir: a directory to create (its parent must exist) only once every
  // check below has passed, so a refused restore leaves nothing behind.
  const createDir = options.createDir ? resolve(options.createDir) : undefined;
  const dirMeta = new Map(dirs.map((dir) => [`${dir.root}/${dir.path}`, dir]));
  // Directories without a recorded entry (an etc-cocalc file's root, say)
  // take the owner of the entry being restored into them, mode 0700.
  const dirFor = (root, path, fallback) =>
    dirMeta.get(`${root}/${path}`) ?? { ...fallback, mode: 0o700 };
  const roots = [...new Set([...dirs, ...files].map((entry) => entry.root))];
  // Shallowest first, so each directory's parent exists when it is made.
  const orderedDirs = dirs
    .filter((dir) => dir.path !== "")
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length);

  // The destination plan: where every entry lands.
  const plan = new Map();
  const claim = (full, kind, what) => {
    const prior = plan.get(full);
    if (prior) {
      throw new Error(
        `${what} and ${prior.what} would both be restored to ${full}`,
      );
    }
    plan.set(full, { kind, what });
  };
  for (const root of roots) claim(baseOf(root), "dir", `${root}/`);
  for (const dir of orderedDirs) {
    claim(fullPath(dir), "dir", `${dir.root}/${dir.path}`);
  }
  for (const file of files) {
    claim(fullPath(file), "file", `${file.root}/${file.path}`);
  }
  for (const [full, { what }] of plan) {
    for (let up = dirname(full); up !== dirname(up); up = dirname(up)) {
      const ancestor = plan.get(up);
      if (ancestor?.kind === "file") {
        throw new Error(
          `${what} would be restored below the file ${ancestor.what}`,
        );
      }
    }
  }

  // Resolve every owner before writing anything.
  const owners = new Map();
  const ownerOf = (entry, what) => {
    if (!chown) return undefined;
    const key = `${entry.owner}:${entry.group}`;
    if (!owners.has(key)) {
      owners.set(key, ids(entry.owner, entry.group, system, what));
    }
    return owners.get(key);
  };
  for (const entry of [...files, ...dirs]) {
    ownerOf(entry, `${entry.root}/${entry.path}`);
    const parts = entry.path ? entry.path.split("/") : [];
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      ownerOf(dirFor(entry.root, path, entry), `${entry.root}/${path}`);
    }
  }

  // Check the destination, so a refusal leaves nothing half written.
  const openParent = (base) => {
    let fd;
    try {
      fd = openNoFollow(dirname(base));
    } catch (err) {
      if (errorCode(err) !== "ENOENT") throw err;
      throw new Error(
        `${dirname(base)} does not exist; the parent of a mapped directory must exist`,
      );
    }
    if (!fstatSync(fd).isDirectory()) {
      closeSync(fd);
      throw new Error(`${dirname(base)} is not a directory`);
    }
    return fd;
  };
  const checkCreateDir = () => {
    const fd = openNoFollow(createDir, { missingOk: true });
    if (fd === undefined) {
      closeSync(openParent(createDir));
      return;
    }
    const isDirectory = fstatSync(fd).isDirectory();
    closeSync(fd);
    if (!isDirectory) {
      throw new Error(
        `${createDir} is not a directory (symbolic links are refused)`,
      );
    }
  };
  for (const root of roots) {
    const base = baseOf(root);
    if (createDir && dirname(base) === createDir) checkCreateDir();
    else closeSync(openParent(base));
  }
  for (const [full, { kind }] of plan) {
    const fd = openNoFollow(full, { missingOk: true });
    if (fd === undefined) continue;
    try {
      const stat = fstatSync(fd);
      if (kind === "dir" && !stat.isDirectory()) {
        throw new Error(
          `${full} is not a directory (symbolic links are refused)`,
        );
      }
      if (kind === "file" && !stat.isFile()) {
        throw new Error(`refusing to replace ${full}: not a regular file`);
      }
      if (kind === "file" && !force) {
        throw new Error(`refusing to overwrite ${full}; pass --force`);
      }
    } finally {
      closeSync(fd);
    }
  }

  if (createDir) makeDirectory(createDir);
  const created = [];
  const ensureDir = (parentFd, name, meta, full) => {
    let made = false;
    try {
      mkdirSync(at(parentFd, name), { mode: 0o700 });
      made = true;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
    }
    const fd = openSync(at(parentFd, name), O_PATH | O_NOFOLLOW);
    if (!fstatSync(fd).isDirectory()) {
      closeSync(fd);
      throw new Error(
        `${full} is not a directory (symbolic links are refused)`,
      );
    }
    if (made) {
      const owner = ownerOf(meta, full);
      if (owner) pathChown(self(fd), owner.uid, owner.gid);
      chmodSync(self(fd), meta.mode);
      created.push(full);
    }
    return fd;
  };
  // A descriptor for root/parts, creating directories as needed; the caller
  // closes it.
  const openDirectory = (root, parts, entry) => {
    const base = baseOf(root);
    const parentFd = openParent(base);
    let fd;
    try {
      fd = ensureDir(parentFd, basename(base), dirFor(root, "", entry), base);
    } finally {
      closeSync(parentFd);
    }
    try {
      for (let i = 0; i < parts.length; i++) {
        const path = parts.slice(0, i + 1).join("/");
        const next = ensureDir(
          fd,
          parts[i],
          dirFor(root, path, entry),
          `${base}/${path}`,
        );
        closeSync(fd);
        fd = next;
      }
    } catch (err) {
      closeSync(fd);
      throw err;
    }
    return fd;
  };
  for (const root of roots) {
    const entry =
      dirs.find((dir) => dir.root === root) ??
      files.find((file) => file.root === root);
    closeSync(openDirectory(root, [], entry));
  }
  for (const dir of orderedDirs) {
    closeSync(openDirectory(dir.root, dir.path.split("/"), dir));
  }
  const restored = [];
  for (const file of files) {
    const parts = file.path.split("/");
    const fd = openDirectory(file.root, parts.slice(0, -1), file);
    try {
      createExclusive(
        fd,
        parts[parts.length - 1],
        file.content,
        file.mode,
        ownerOf(file, `${file.root}/${file.path}`),
        fchown,
      );
      restored.push(fullPath(file));
    } finally {
      closeSync(fd);
    }
  }
  return { restored, created };
}

/**
 * Create directory `path` (its parent must exist) without following a
 * symbolic link anywhere; an existing directory is fine.
 */
function makeDirectory(path, mode = 0o700) {
  const target = resolve(path);
  const parentFd = openNoFollow(dirname(target));
  try {
    try {
      mkdirSync(at(parentFd, basename(target)), { mode });
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
    }
    const fd = openSync(at(parentFd, basename(target)), O_PATH | O_NOFOLLOW);
    const isDirectory = fstatSync(fd).isDirectory();
    closeSync(fd);
    if (!isDirectory) {
      throw new Error(
        `${target} is not a directory (symbolic links are refused)`,
      );
    }
  } finally {
    closeSync(parentFd);
  }
}

// --- command line ---------------------------------------------------------

function parseArgs(argv) {
  const options = { include: [], exclude: [], map: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force" || arg === "--chown") options[arg.slice(2)] = true;
    else if (arg === "--include" || arg === "--exclude" || arg === "--map") {
      options[arg.slice(2)].push(argv[++i]);
    } else if (arg.startsWith("--")) {
      options[arg.slice(2).replace(/-/g, "_")] = argv[++i];
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return options;
}

function parsePairs(values, what) {
  return values.map((value) => {
    const index = `${value}`.indexOf("=");
    if (index <= 0) throw new Error(`expected ${what} as ROOT=PATH: ${value}`);
    return {
      root: checkRoot(value.slice(0, index)),
      path: value.slice(index + 1),
    };
  });
}

// For --out: a new file next to the target, renamed over it.
function writeOut(path, data, mode) {
  const target = resolve(path);
  const dirFd = openNoFollow(dirname(target));
  try {
    createExclusive(dirFd, basename(target), Buffer.from(data), mode);
  } finally {
    closeSync(dirFd);
  }
}

const entryKey = ({ root, path }) => `${root}/${path}`;

function differences(sealed, live) {
  const problems = [];
  for (const kind of ["files", "dirs"]) {
    const copies = new Map(
      sealed[kind].map((entry) => [entryKey(entry), entry]),
    );
    const current = new Map(
      live[kind].map((entry) => [entryKey(entry), entry]),
    );
    for (const [key, entry] of current) {
      const copy = copies.get(key);
      if (!copy) problems.push(`${key}: missing from escrow`);
      else if (
        copy.mode !== entry.mode ||
        copy.owner !== entry.owner ||
        copy.group !== entry.group ||
        (kind === "files" && !copy.content.equals(entry.content))
      ) {
        problems.push(`${key}: differs`);
      }
    }
    for (const key of copies.keys()) {
      if (!current.has(key)) problems.push(`${key}: not live`);
    }
  }
  return problems;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  const masterKey = () => {
    if (!options.master_key) throw new Error("--master-key FILE is required");
    return parseMasterKey(readSmallFile(options.master_key, 4096));
  };
  const live = () => {
    if (options.include.length === 0)
      throw new Error("at least one --include ROOT=PATH is required");
    return collect(parsePairs(options.include, "--include"), options.exclude);
  };
  if (command === "seal") {
    if (!options.out) throw new Error("seal requires --out ESCROW");
    const { files, dirs } = live();
    const envelope = seal({
      masterKey: masterKey(),
      bayId: options.bay_id,
      files,
      dirs,
    });
    const text = JSON.stringify(envelope, null, 2) + "\n";
    if (text.length > LIMITS.envelopeBytes) throw new Error("escrow too large");
    writeOut(options.out, text, 0o600);
    console.log(
      JSON.stringify({
        sealed: files.map(entryKey),
        directories: dirs.length,
        created_at: envelope.created_at,
      }),
    );
  } else if (command === "verify") {
    // The sealed copy must decrypt to exactly the live files and directories.
    const sealed = open({
      masterKey: masterKey(),
      envelope: readEnvelope(options.in),
    });
    const problems = differences(sealed, live());
    if (problems.length)
      throw new Error(`escrow does not match: ${problems.join("; ")}`);
    console.log(JSON.stringify({ verified: sealed.files.map(entryKey) }));
  } else if (command === "open") {
    const payload = open({
      masterKey: masterKey(),
      envelope: readEnvelope(options.in),
    });
    const bases = new Map(
      parsePairs(options.map, "--map").map(({ root, path }) => [root, path]),
    );
    if (options.out_dir) {
      for (const { root } of [...payload.files, ...payload.dirs]) {
        if (!bases.has(root)) bases.set(root, `${options.out_dir}/${root}`);
      }
    }
    if (bases.size === 0) {
      throw new Error("open requires --out-dir DIR or --map ROOT=DIR");
    }
    // --out-dir itself may be new; its parent must exist.
    const result = restore(payload, bases, {
      createDir: options.out_dir,
      force: !!options.force,
      chown: !!options.chown,
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "info") {
    const envelope = readEnvelope(options.in);
    checkEnvelope(envelope);
    const info = Object.fromEntries(
      HEADER_FIELDS.map((field) => [field, envelope[field] ?? null]),
    );
    if (options.master_key) {
      const { files, dirs } = open({ masterKey: masterKey(), envelope });
      Object.assign(info, {
        authenticated: true,
        file_names: files.map(entryKey),
        directories: dirs.length,
      });
    } else {
      // Anyone can edit these fields; pass --master-key to authenticate them.
      info.authenticated = false;
    }
    console.log(JSON.stringify(info, null, 2));
  } else {
    throw new Error(
      "usage: bay-config-escrow.mjs seal|verify|open|info ... (see the file header)",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    main();
  } catch (err) {
    console.error(`bay-config-escrow: ${err?.message ?? err}`);
    process.exit(1);
  }
}
