#!/usr/bin/env node
/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Escrow of a bay's /etc/cocalc configuration, sealed with the site master key.
//
// The bay's backups are useless without bay-secrets.env: it holds the
// pgBackRest repository cipher passphrase, the backup R2 credentials, the
// SQLite repository password, and the session/cluster secrets. Only the site
// master key is kept off the bay (in 1Password). This file seals the bay
// configuration with a key derived from that master key, so the copy kept next
// to the backups in R2 is all a restore needs besides the master key.
//
// Built-ins only: it must run from a plain repository checkout on a fresh
// machine, with no install step. R2 transfers are done by the caller
// (bay-config-escrow-run, or curl --aws-sigv4 during a restore).
//
// Usage:
//   bay-config-escrow.mjs seal --master-key FILE --bay-id ID --out ESCROW FILE...
//   bay-config-escrow.mjs open --master-key FILE --in ESCROW --out-dir DIR [--force]
//   bay-config-escrow.mjs verify --master-key FILE --in ESCROW FILE...
//   bay-config-escrow.mjs info --in ESCROW

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
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

export const ESCROW_KIND = "cocalc-bay-config-escrow";
export const ESCROW_VERSION = 1;
// Must match deriveSiteMasterKey(key, "bay-config-escrow:v1") in
// @cocalc/util/master-key-lifecycle.
export const ESCROW_PURPOSE = "bay-config-escrow:v1";
const MAX_FILE_BYTES = 1024 * 1024;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
    files: files.map(({ name, mode, content }) => {
      if (!FILE_NAME.test(name))
        throw new Error(`invalid escrow file name: ${name}`);
      if (content.length > MAX_FILE_BYTES)
        throw new Error(`escrow file too large: ${name}`);
      return {
        name,
        mode: mode & 0o777,
        sha256: createHash("sha256").update(content).digest("hex"),
        content: content.toString("base64"),
      };
    }),
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
    // Names only, for operators; contents and hashes stay encrypted.
    file_names: payload.files.map(({ name }) => name),
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
  return files.map(({ name, mode, sha256, content }) => {
    if (!FILE_NAME.test(name))
      throw new Error(`invalid escrow file name: ${name}`);
    const data = Buffer.from(content, "base64");
    if (createHash("sha256").update(data).digest("hex") !== sha256) {
      throw new Error(`escrow file ${name} failed its checksum`);
    }
    return { name, mode, content: data };
  });
}

function readFiles(paths) {
  return paths.map((path) => ({
    name: basename(path),
    mode: statSync(path).mode,
    content: readFileSync(path),
  }));
}

function parseArgs(argv) {
  const options = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") options.force = true;
    else if (arg.startsWith("--"))
      options[arg.slice(2).replace(/-/g, "_")] = argv[++i];
    else options.files.push(arg);
  }
  return options;
}

function writeAtomic(path, data, mode) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  const readEnvelope = () => JSON.parse(readFileSync(options.in, "utf8"));
  const masterKey = () => {
    if (!options.master_key) throw new Error("--master-key FILE is required");
    return parseMasterKey(readFileSync(options.master_key, "utf8"));
  };
  if (command === "seal") {
    if (!options.out || options.files.length === 0) {
      throw new Error(
        "usage: seal --master-key FILE --bay-id ID --out ESCROW FILE...",
      );
    }
    const envelope = seal({
      masterKey: masterKey(),
      bayId: options.bay_id,
      files: readFiles(options.files),
    });
    writeAtomic(options.out, JSON.stringify(envelope, null, 2) + "\n", 0o600);
    console.log(
      JSON.stringify({
        sealed: envelope.file_names,
        created_at: envelope.created_at,
      }),
    );
  } else if (command === "open") {
    if (!options.in || !options.out_dir) {
      throw new Error(
        "usage: open --master-key FILE --in ESCROW --out-dir DIR [--force]",
      );
    }
    const files = open({ masterKey: masterKey(), envelope: readEnvelope() });
    mkdirSync(options.out_dir, { recursive: true, mode: 0o755 });
    for (const { name } of files) {
      if (!options.force && existsSync(join(options.out_dir, name))) {
        throw new Error(
          `refusing to overwrite ${join(options.out_dir, name)}; pass --force`,
        );
      }
    }
    for (const { name, mode, content } of files) {
      writeAtomic(join(options.out_dir, name), content, mode || 0o600);
    }
    console.log(
      JSON.stringify({
        restored: files.map(({ name }) => name),
        out_dir: options.out_dir,
      }),
    );
  } else if (command === "verify") {
    // The sealed copy must decrypt to exactly the live files.
    const sealed = new Map(
      open({ masterKey: masterKey(), envelope: readEnvelope() }).map((file) => [
        file.name,
        file,
      ]),
    );
    const live = readFiles(options.files);
    const problems = [];
    for (const file of live) {
      const copy = sealed.get(file.name);
      if (!copy) problems.push(`${file.name}: missing from escrow`);
      else if (!copy.content.equals(file.content))
        problems.push(`${file.name}: differs`);
    }
    for (const name of sealed.keys()) {
      if (!live.some((file) => file.name === name))
        problems.push(`${name}: not a live file`);
    }
    if (problems.length)
      throw new Error(`escrow does not match: ${problems.join("; ")}`);
    console.log(JSON.stringify({ verified: [...sealed.keys()] }));
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
      "usage: bay-config-escrow.mjs seal|open|verify|info ... (see the file header)",
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
