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
// backups in R2 is all a restore needs besides the master key.
//
// Built-ins only: it must run from a plain repository checkout on a fresh
// machine, with no install step. R2 transfers are done by the caller
// (bay-config-escrow-run, or curl --aws-sigv4 during a restore).
//
// Each included file belongs to a named root, e.g. etc-cocalc (/etc/cocalc)
// or bay-secrets (the bay SECRETS directory), and is stored by its path
// relative to that root.
//
// Usage:
//   seal   --master-key FILE --bay-id ID --out ESCROW --include ROOT=PATH...
//          [--exclude GLOB...]   (PATH is a file or a directory tree)
//   verify --master-key FILE --in ESCROW --include ROOT=PATH... [--exclude GLOB...]
//   open   --master-key FILE --in ESCROW (--out-dir DIR | --map ROOT=DIR...)
//          [--force] [--chown]
//   info   --in ESCROW

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
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { pathToFileURL } from "node:url";

export const ESCROW_KIND = "cocalc-bay-config-escrow";
export const ESCROW_VERSION = 1;
// Must match deriveSiteMasterKey(key, "bay-config-escrow:v1") in
// @cocalc/util/master-key-lifecycle.
export const ESCROW_PURPOSE = "bay-config-escrow:v1";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 2000;
const ROOT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const PATH_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/;

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
// usable about it, so `open` can say "wrong key" instead of "corrupt".
function keyCheck(escrowKey) {
  return createHmac("sha256", escrowKey)
    .update("cocalc-bay-config-escrow key check")
    .digest("base64")
    .slice(0, 22);
}

function header(envelope) {
  // The authenticated metadata, in a fixed order.
  return Buffer.from(
    JSON.stringify([
      envelope.kind,
      envelope.version,
      envelope.bay_id,
      envelope.created_at,
      envelope.purpose,
      envelope.key_check,
    ]),
  );
}

/** A safe relative path: no absolute paths, "..", or empty components. */
export function checkRelativePath(path) {
  const parts = `${path}`.split("/");
  if (parts.length > 16 || parts.some((part) => !PATH_PART.test(part))) {
    throw new Error(`invalid escrow path: ${JSON.stringify(path)}`);
  }
  return parts.join("/");
}

function checkRoot(root) {
  if (!ROOT_NAME.test(`${root}`)) {
    throw new Error(`invalid escrow root: ${JSON.stringify(root)}`);
  }
  return root;
}

function globToRegExp(glob) {
  const escaped = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${escaped}$`);
}

function ownerName(uid) {
  try {
    return execFileSync("id", ["-nu", String(uid)], {
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Regular files under each include, by root and relative path. Symbolic links
 * and other special files are refused rather than followed.
 */
export function collectFiles(includes, excludes = []) {
  const patterns = excludes.map(globToRegExp);
  const owners = new Map();
  const files = [];
  const add = (root, path, full, stat) => {
    if (patterns.some((pattern) => pattern.test(path))) return;
    if (!stat.isFile()) {
      throw new Error(`refusing to escrow a non-regular file: ${full}`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`escrow file too large (${stat.size} bytes): ${full}`);
    }
    if (!owners.has(stat.uid)) owners.set(stat.uid, ownerName(stat.uid));
    files.push({
      root,
      path: checkRelativePath(path),
      mode: stat.mode & 0o777,
      owner: owners.get(stat.uid),
      content: readFileSync(full),
    });
  };
  const walk = (root, dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const path = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(root, full, path);
      else add(root, path, full, stat);
    }
  };
  for (const { root, path } of includes) {
    checkRoot(root);
    const stat = lstatSync(path);
    if (stat.isDirectory()) walk(root, path, "");
    else add(root, basename(path), path, stat);
  }
  if (files.length > MAX_FILES) throw new Error("too many files to escrow");
  const seen = new Set();
  for (const { root, path } of files) {
    const key = `${root}/${path}`;
    if (seen.has(key)) throw new Error(`duplicate escrow path: ${key}`);
    seen.add(key);
  }
  return files;
}

export function seal({
  masterKey,
  bayId,
  files,
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
    host,
  };
  const payload = {
    files: files.map(({ root, path, mode, owner, content }) => ({
      root: checkRoot(root),
      path: checkRelativePath(path),
      mode: mode & 0o777,
      owner: owner ?? null,
      sha256: createHash("sha256").update(content).digest("hex"),
      content: content.toString("base64"),
    })),
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", escrowKey, iv);
  cipher.setAAD(header(envelope));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    ...envelope,
    // Paths only, for operators; contents and hashes stay encrypted.
    file_names: payload.files.map(({ root, path }) => `${root}/${path}`),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function open({ masterKey, envelope }) {
  if (envelope?.kind !== ESCROW_KIND || envelope.version !== ESCROW_VERSION) {
    throw new Error("not a CoCalc bay configuration escrow (version 1)");
  }
  const escrowKey = deriveEscrowKey(masterKey);
  if (envelope.key_check !== keyCheck(escrowKey)) {
    throw new Error(
      "this escrow was sealed with a different site master key; use the site master key of the site being restored",
    );
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    escrowKey,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAAD(header(envelope));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
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
  const { files } = JSON.parse(plaintext.toString("utf8"));
  return files.map(({ root, path, mode, owner, sha256, content }) => {
    const data = Buffer.from(content, "base64");
    if (createHash("sha256").update(data).digest("hex") !== sha256) {
      throw new Error(`escrow file ${root}/${path} failed its checksum`);
    }
    return {
      root: checkRoot(root),
      path: checkRelativePath(path),
      mode: mode & 0o777,
      owner: owner ?? null,
      content: data,
    };
  });
}

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

function writeAtomic(path, data, mode) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function uidGid(user) {
  try {
    const uid = Number(execFileSync("id", ["-u", user], { encoding: "utf8" }));
    const gid = Number(execFileSync("id", ["-g", user], { encoding: "utf8" }));
    return { uid, gid };
  } catch {
    return undefined;
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  const readEnvelope = () => JSON.parse(readFileSync(options.in, "utf8"));
  const masterKey = () => {
    if (!options.master_key) throw new Error("--master-key FILE is required");
    return parseMasterKey(readFileSync(options.master_key, "utf8"));
  };
  const live = () => {
    if (options.include.length === 0)
      throw new Error("at least one --include ROOT=PATH is required");
    return collectFiles(
      parsePairs(options.include, "--include"),
      options.exclude,
    );
  };
  if (command === "seal") {
    if (!options.out) throw new Error("seal requires --out ESCROW");
    const envelope = seal({
      masterKey: masterKey(),
      bayId: options.bay_id,
      files: live(),
    });
    writeAtomic(options.out, JSON.stringify(envelope, null, 2) + "\n", 0o600);
    console.log(
      JSON.stringify({
        sealed: envelope.file_names,
        created_at: envelope.created_at,
      }),
    );
  } else if (command === "verify") {
    // The sealed copy must decrypt to exactly the live files.
    const key = ({ root, path }) => `${root}/${path}`;
    const sealed = new Map(
      open({ masterKey: masterKey(), envelope: readEnvelope() }).map((file) => [
        key(file),
        file,
      ]),
    );
    const current = live();
    const problems = [];
    for (const file of current) {
      const copy = sealed.get(key(file));
      if (!copy) problems.push(`${key(file)}: missing from escrow`);
      else if (!copy.content.equals(file.content) || copy.mode !== file.mode) {
        problems.push(`${key(file)}: differs`);
      }
    }
    for (const name of sealed.keys()) {
      if (!current.some((file) => key(file) === name))
        problems.push(`${name}: not a live file`);
    }
    if (problems.length)
      throw new Error(`escrow does not match: ${problems.join("; ")}`);
    console.log(JSON.stringify({ verified: [...sealed.keys()] }));
  } else if (command === "open") {
    const files = open({ masterKey: masterKey(), envelope: readEnvelope() });
    const mapped = new Map(
      parsePairs(options.map, "--map").map(({ root, path }) => [root, path]),
    );
    if (!options.out_dir && mapped.size === 0) {
      throw new Error("open requires --out-dir DIR or --map ROOT=DIR");
    }
    const baseOf = (file) => {
      const base =
        mapped.get(file.root) ??
        (options.out_dir ? join(options.out_dir, file.root) : null);
      if (!base)
        throw new Error(
          `no destination for root ${file.root}; add --map ${file.root}=DIR`,
        );
      return base;
    };
    const destination = (file) => join(baseOf(file), ...file.path.split("/"));
    for (const file of files) {
      if (!options.force && existsSync(destination(file))) {
        throw new Error(
          `refusing to overwrite ${destination(file)}; pass --force`,
        );
      }
    }
    const canChown = options.chown && userInfo().uid === 0;
    for (const file of files) {
      const target = destination(file);
      mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
      writeAtomic(target, file.content, file.mode || 0o600);
      const ids = canChown && file.owner ? uidGid(file.owner) : undefined;
      if (ids) {
        // The file and the directories it created below its root.
        chownSync(target, ids.uid, ids.gid);
        const parts = file.path.split("/").slice(0, -1);
        for (let i = 1; i <= parts.length; i++) {
          chownSync(join(baseOf(file), ...parts.slice(0, i)), ids.uid, ids.gid);
        }
      }
    }
    console.log(JSON.stringify({ restored: files.map(destination) }, null, 2));
  } else if (command === "info") {
    const { kind, version, bay_id, created_at, host, file_names } =
      readEnvelope();
    console.log(
      JSON.stringify(
        { kind, version, bay_id, created_at, host, file_names },
        null,
        2,
      ),
    );
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
