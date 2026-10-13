#!/usr/bin/env node
/*
 * Publish a CLI release built by build-release.mjs (distribution Phase A).
 *
 * The release store has one layout, on R2 or in a local directory:
 *
 *   files/<sha256>             immutable, content-addressed
 *   manifests/<sha256>.json    immutable release manifests
 *   current.json               the single origin-wide pointer
 *
 * Publishing is ordered so no reader ever sees a pointer to something missing:
 * the files first, then the manifest, then the pointer flip. Every hub that
 * serves this store reads the same pointer.
 *
 * Usage:
 *   node dist-release/publish-release.mjs [--build DIR]
 *     [--dir STORE | --prefix software/cli]   (R2 needs COCALC_R2_* env)
 *     [--min-release N|this|none] [--release N] [--dry-run]
 *
 * The release number is max(current + 1, unix seconds), so it only grows.
 * --min-release keeps the store's current minimum unless given; "this"
 * makes this release the minimum (clients must update before using the site).
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const require = createRequire(join(cliRoot, "package.json"));
const {
  MANIFEST_SCHEMA,
  POINTER_SCHEMA,
  parseManifest,
  parsePointer,
} = require("@cocalc/util/cli-distribution/schema");

const IMMUTABLE = "public, max-age=31536000, immutable";
const POINTER_CACHE = "public, max-age=30";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function dirStore(root) {
  const path = (key) => join(root, ...key.split("/"));
  return {
    describe: root,
    async get(key) {
      return existsSync(path(key)) ? readFileSync(path(key)) : undefined;
    },
    async list(prefix) {
      const dir = path(prefix);
      return existsSync(dir) ? readdirSync(dir) : [];
    },
    async put(key, body) {
      const target = path(key);
      mkdirSync(dirname(target), { recursive: true });
      const temp = `${target}.tmp-${process.pid}`;
      writeFileSync(temp, body);
      renameSync(temp, target);
    },
  };
}

function r2Store(prefix) {
  let r2;
  try {
    r2 = require("@cocalc/backend/r2");
  } catch (err) {
    throw new Error(
      `cannot load @cocalc/backend/r2; build @cocalc/backend first (${err?.message ?? err})`,
    );
  }
  const env = process.env;
  const accountId = env.COCALC_R2_ACCOUNT_ID;
  const auth = {
    endpoint:
      env.COCALC_R2_ENDPOINT ||
      (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : ""),
    accessKey: env.COCALC_R2_ACCESS_KEY_ID ?? "",
    secretKey: env.COCALC_R2_SECRET_ACCESS_KEY ?? "",
    bucket: env.COCALC_R2_BUCKET ?? "",
    region: env.COCALC_R2_REGION || "auto",
  };
  if (!auth.endpoint || !auth.accessKey || !auth.secretKey || !auth.bucket) {
    throw new Error(
      "R2 needs COCALC_R2_ACCOUNT_ID (or COCALC_R2_ENDPOINT), COCALC_R2_ACCESS_KEY_ID, COCALC_R2_SECRET_ACCESS_KEY and COCALC_R2_BUCKET; or publish to a directory with --dir.",
    );
  }
  const key = (name) => `${prefix}/${name}`;
  return {
    describe: `r2://${auth.bucket}/${prefix}`,
    async get(name) {
      return await r2.getR2ObjectBuffer({ auth, key: key(name) });
    },
    async list(name) {
      const keys = await r2.listR2ObjectKeys({ auth, prefix: key(name) + "/" });
      return keys.map((k) => k.split("/").pop());
    },
    async put(name, body, { contentType, cacheControl }) {
      await r2.putR2ObjectFromBuffer({
        auth,
        key: key(name),
        body,
        contentType,
        cacheControl,
      });
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const buildDir = resolve(
    typeof args.build === "string"
      ? args.build
      : join(cliRoot, "build", "cli-release"),
  );
  const build = JSON.parse(readFileSync(join(buildDir, "build.json"), "utf8"));
  const store =
    typeof args.dir === "string"
      ? dirStore(resolve(args.dir))
      : r2Store(typeof args.prefix === "string" ? args.prefix : "software/cli");
  const dryRun = !!args["dry-run"];

  const currentBytes = await store.get("current.json");
  const current = currentBytes
    ? parsePointer(currentBytes.toString("utf8"))
    : undefined;
  const release =
    typeof args.release === "string"
      ? Number(args.release)
      : Math.max((current?.release ?? 0) + 1, Math.floor(Date.now() / 1000));
  if (!Number.isSafeInteger(release) || release <= (current?.release ?? 0)) {
    throw new Error(
      `release ${release} must be greater than the current release ${current?.release}`,
    );
  }
  let minRelease = current?.min_release ?? null;
  if (args["min-release"] === "none") {
    minRelease = null;
  } else if (args["min-release"] === "this") {
    minRelease = release;
  } else if (typeof args["min-release"] === "string") {
    minRelease = Number(args["min-release"]);
  }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    release,
    version: build.version,
    git: build.git,
    built_at: build.built_at,
    launcher: build.launcher,
    bootstrap: build.bootstrap,
    bundle: build.bundle,
    node: build.node,
  };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  parseManifest(manifestText);
  const manifestHash = sha256(Buffer.from(manifestText));
  const pointer = {
    schema: POINTER_SCHEMA,
    release,
    manifest: manifestHash,
    min_release: minRelease,
    published_at: new Date().toISOString(),
  };
  const pointerText = JSON.stringify(pointer, null, 2) + "\n";
  parsePointer(pointerText);

  const files = [build.launcher, build.bootstrap, build.bundle];
  for (const archive of Object.values(build.node.platforms))
    files.push(archive);
  const existing = new Set(await store.list("files"));
  process.stdout.write(
    `Publishing CLI release ${release} (manifest ${manifestHash.slice(0, 12)}) to ${store.describe}\n`,
  );
  for (const file of files) {
    if (existing.has(file.sha256)) continue;
    const body = readFileSync(join(buildDir, "files", file.sha256));
    if (body.length !== file.size || sha256(body) !== file.sha256) {
      throw new Error(`build file ${file.sha256} does not match build.json`);
    }
    process.stdout.write(`  files/${file.sha256} (${body.length} bytes)\n`);
    if (!dryRun) {
      await store.put(`files/${file.sha256}`, body, {
        contentType: "application/octet-stream",
        cacheControl: IMMUTABLE,
      });
    }
  }
  process.stdout.write(`  manifests/${manifestHash}.json\n`);
  if (!dryRun) {
    await store.put(`manifests/${manifestHash}.json`, manifestText, {
      contentType: "application/json",
      cacheControl: IMMUTABLE,
    });
  }
  process.stdout.write(
    `  current.json -> release ${release}${minRelease ? `, min_release ${minRelease}` : ""}\n`,
  );
  if (!dryRun) {
    await store.put("current.json", pointerText, {
      contentType: "application/json",
      cacheControl: POINTER_CACHE,
    });
  }
  process.stdout.write(dryRun ? "Dry run: nothing written.\n" : "Published.\n");
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
