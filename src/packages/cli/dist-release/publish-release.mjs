#!/usr/bin/env node
/*
 * Publish a CLI release built by build-release.mjs (distribution Phase A).
 *
 * The release store has one layout, on R2 or in a local directory:
 *
 *   files/<sha256>             immutable, content-addressed
 *   manifests/<sha256>.json    immutable release manifests
 *   releases/<N>.json          which manifest release number N names
 *   current.json               the single origin-wide pointer
 *
 * Publishing is ordered so no reader ever sees a pointer to something
 * missing: files, then the manifest, then the release-number reservation,
 * then the pointer. Two publishers can't collide: the release number is
 * reserved with a create-only write (one number names one manifest), and
 * current.json is replaced only if it is still the version read at the start
 * (a conditional write; on R2, If-None-Match/If-Match). Existing
 * content-addressed objects are verified, not trusted.
 *
 * Usage:
 *   node dist-release/publish-release.mjs [--build DIR]
 *     [--dir STORE | --prefix software/cli]   (R2 needs COCALC_R2_* env)
 *     [--min-release N|this|none] [--release N] [--dry-run]
 *     [--public-url URL]   (CoCalc Plus: the store's public URL, which its
 *                           install.sh downloads from; default
 *                           https://software.cocalc.ai/<prefix>)
 *
 * The same command publishes a CoCalc Plus build (plus/dist-release); then the
 * store also gets a generated install.sh, written last.
 *
 * The release number is max(current + 1, unix seconds), so it only grows.
 * --min-release keeps the store's current minimum unless given; "this"
 * makes this release the minimum. It is advisory: current CLIs update before
 * using the site, but nothing stops an older CLI (see cli/src/distribution/
 * auto.ts).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
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
  canonicalJson,
  parseManifest,
  parsePointer,
} = require("@cocalc/util/cli-distribution/schema");
const {
  PLUS_MANIFEST_SCHEMA,
  parsePlusManifest,
} = require("@cocalc/util/cli-distribution/plus-schema");

/*
 * What a build directory describes. A CLI build.json (from
 * dist-release/build-release.mjs) has the CLI fields; a build.json with a
 * `schema` (CoCalc Plus, from plus/dist-release/build-release.mjs) carries
 * its manifest fields and its file list explicitly.
 */
function product(build) {
  if (build.schema === PLUS_MANIFEST_SCHEMA) {
    return {
      name: "CoCalc Plus",
      prefix: "software/plus",
      files: build.files,
      manifest: (release) => ({
        schema: PLUS_MANIFEST_SCHEMA,
        release,
        ...build.fields,
      }),
      parse: parsePlusManifest,
      installScript: true,
    };
  }
  const files = [build.launcher, build.bootstrap, build.bundle];
  for (const archive of Object.values(build.node.platforms)) {
    files.push(archive);
  }
  return {
    name: "CoCalc CLI",
    prefix: "software/cli",
    files,
    manifest: (release) => ({
      schema: MANIFEST_SCHEMA,
      release,
      version: build.version,
      git: build.git,
      built_at: build.built_at,
      launcher: build.launcher,
      bootstrap: build.bootstrap,
      bundle: build.bundle,
      node: build.node,
    }),
    parse: parseManifest,
    installScript: false,
  };
}

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

/*
 * A store has: get(name) -> {body, version} | undefined;
 * create(name, body, opts) -> true, or false if it already exists;
 * replace(name, body, version, opts) -> true, or false if the object is no
 * longer at `version` (undefined = must not exist); put(name, body, opts).
 */
function dirStore(root) {
  const path = (name) => join(root, ...name.split("/"));
  const temp = (target) => {
    mkdirSync(dirname(target), { recursive: true });
    return `${target}.${randomBytes(6).toString("hex")}.tmp`;
  };
  const lock = join(root, ".publish-lock");
  return {
    describe: root,
    // Serializes local publishers; replace() is checked under it.
    acquire() {
      mkdirSync(root, { recursive: true });
      try {
        writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
      } catch {
        throw new Error(
          `another publish holds ${lock}; if none is running, remove it`,
        );
      }
      return () => unlinkSync(lock);
    },
    async get(name) {
      if (!existsSync(path(name))) return undefined;
      const body = readFileSync(path(name));
      return { body, version: sha256(body) };
    },
    async create(name, body) {
      const target = path(name);
      const t = temp(target);
      writeFileSync(t, body);
      try {
        linkSync(t, target);
        return true;
      } catch (err) {
        if (err?.code === "EEXIST") return false;
        throw err;
      } finally {
        unlinkSync(t);
      }
    },
    async replace(name, body, version) {
      const current = await this.get(name);
      if (current?.version !== version) return false;
      const target = path(name);
      const t = temp(target);
      writeFileSync(t, body);
      renameSync(t, target);
      return true;
    },
    async put(name, body) {
      const target = path(name);
      const t = temp(target);
      writeFileSync(t, body);
      renameSync(t, target);
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
  const send = async (method, name, body, headers = {}) =>
    await r2.sendR2Request({
      auth,
      method,
      key: key(name),
      payload: body,
      extraHeaders: headers,
      label: `R2 ${method} ${key(name)}`,
    });
  const putHeaders = ({ contentType, cacheControl }, body) => ({
    "content-type": contentType,
    "cache-control": cacheControl,
    "content-length": Buffer.byteLength(body),
  });
  const check = (response, name) => {
    if (response.statusCode >= 200 && response.statusCode < 300) return true;
    if (response.statusCode === 412) return false;
    throw new Error(`R2 ${key(name)}: HTTP ${response.statusCode}`);
  };
  return {
    describe: `r2://${auth.bucket}/${prefix}`,
    acquire: () => () => {},
    async get(name) {
      const response = await send("GET", name);
      if (response.statusCode === 404) return undefined;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`R2 GET ${key(name)}: HTTP ${response.statusCode}`);
      }
      return { body: response.body, version: `${response.headers.etag}` };
    },
    async create(name, body, opts) {
      return check(
        await send("PUT", name, body, {
          ...putHeaders(opts, body),
          "if-none-match": "*",
        }),
        name,
      );
    },
    async replace(name, body, version, opts) {
      return check(
        await send("PUT", name, body, {
          ...putHeaders(opts, body),
          ...(version == null
            ? { "if-none-match": "*" }
            : { "if-match": version }),
        }),
        name,
      );
    },
    async put(name, body, opts) {
      check(await send("PUT", name, body, putHeaders(opts, body)), name);
    },
  };
}

// Upload a content-addressed object unless an intact copy is there already.
async function putImmutable(store, name, body, expected, opts, dryRun) {
  const existing = await store.get(name);
  if (existing != null) {
    if (sha256(existing.body) === expected) return "kept";
    process.stdout.write(`  ${name} in the store is damaged; replacing it\n`);
  }
  if (!dryRun) await store.put(name, body, opts);
  return "uploaded";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const buildDir = resolve(
    typeof args.build === "string"
      ? args.build
      : join(cliRoot, "build", "cli-release"),
  );
  const build = JSON.parse(readFileSync(join(buildDir, "build.json"), "utf8"));
  const kind = product(build);
  const prefix = typeof args.prefix === "string" ? args.prefix : kind.prefix;
  const store =
    typeof args.dir === "string"
      ? dirStore(resolve(args.dir))
      : r2Store(prefix);
  const publicUrl =
    typeof args["public-url"] === "string"
      ? args["public-url"].replace(/\/+$/, "")
      : `https://software.cocalc.ai/${prefix}`;
  const dryRun = !!args["dry-run"];
  const release_ = store.acquire();
  try {
    await publish({ args, kind, buildDir, store, dryRun, publicUrl });
  } finally {
    release_();
  }
}

async function publish({ args, kind, buildDir, store, dryRun, publicUrl }) {
  process.stdout.write(`Publishing ${kind.name} to ${store.describe}\n`);
  for (const file of kind.files) {
    const body = readFileSync(join(buildDir, "files", file.sha256));
    if (body.length !== file.size || sha256(body) !== file.sha256) {
      throw new Error(`build file ${file.sha256} does not match build.json`);
    }
    const result = await putImmutable(
      store,
      `files/${file.sha256}`,
      body,
      file.sha256,
      { contentType: "application/octet-stream", cacheControl: IMMUTABLE },
      dryRun,
    );
    process.stdout.write(`  files/${file.sha256}: ${result}\n`);
  }

  // Choose a number and reserve it; then move current.json only if nobody
  // else has since.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await store.get("current.json");
    const pointer = current
      ? parsePointer(current.body.toString("utf8"))
      : undefined;
    const release =
      typeof args.release === "string"
        ? Number(args.release)
        : Math.max((pointer?.release ?? 0) + 1, Math.floor(Date.now() / 1000));
    if (!Number.isSafeInteger(release) || release <= (pointer?.release ?? 0)) {
      throw new Error(
        `release ${release} must be greater than the current release ${pointer?.release}`,
      );
    }
    let minRelease = pointer?.min_release ?? null;
    if (args["min-release"] === "none") {
      minRelease = null;
    } else if (args["min-release"] === "this") {
      minRelease = release;
    } else if (typeof args["min-release"] === "string") {
      minRelease = Number(args["min-release"]);
    }
    const manifestText = canonicalJson(kind.manifest(release), true);
    kind.parse(manifestText);
    const manifestHash = sha256(Buffer.from(manifestText));
    const pointerText = canonicalJson(
      {
        schema: POINTER_SCHEMA,
        release,
        manifest: manifestHash,
        min_release: minRelease,
        published_at: new Date().toISOString(),
      },
      true,
    );
    parsePointer(pointerText);
    const json = { contentType: "application/json", cacheControl: IMMUTABLE };
    process.stdout.write(
      `Release ${release}: manifests/${manifestHash}.json\n`,
    );
    if (dryRun) {
      process.stdout.write("Dry run: nothing written.\n");
      return;
    }
    await putImmutable(
      store,
      `manifests/${manifestHash}.json`,
      manifestText,
      manifestHash,
      json,
      false,
    );
    const reservation = canonicalJson({ manifest: manifestHash }, true);
    if (!(await store.create(`releases/${release}.json`, reservation, json))) {
      const taken = await store.get(`releases/${release}.json`);
      if (taken?.body.toString("utf8") !== reservation) {
        process.stdout.write(
          `  release ${release} is taken by another publish; choosing again\n`,
        );
        if (typeof args.release === "string") {
          throw new Error(`release ${release} is already taken`);
        }
        continue;
      }
    }
    const moved = await store.replace(
      "current.json",
      pointerText,
      current?.version,
      { contentType: "application/json", cacheControl: POINTER_CACHE },
    );
    if (!moved) {
      process.stdout.write(
        "  current.json changed during this publish; choosing again\n",
      );
      continue;
    }
    const check = await store.get("current.json");
    if (check?.body.toString("utf8") !== pointerText) {
      throw new Error(
        "current.json was overwritten right after this publish; check the store",
      );
    }
    process.stdout.write(
      `Published: current.json -> release ${release}${minRelease ? `, min_release ${minRelease}` : ""}\n`,
    );
    if (kind.installScript) {
      // Written after the pointer: an install.sh never names a release
      // that isn't published. An older one still installs a valid release.
      const { plusInstallScript } =
        await import("../../plus/dist-release/install-script.mjs");
      await store.put(
        "install.sh",
        plusInstallScript({
          origin: publicUrl,
          manifestHash,
          manifestSize: Buffer.byteLength(manifestText),
          manifest: kind.parse(manifestText),
        }),
        {
          contentType: "text/plain; charset=utf-8",
          cacheControl: "public, max-age=60",
        },
      );
      process.stdout.write(`Published: install.sh (from ${publicUrl})\n`);
    }
    return;
  }
  throw new Error(
    "could not publish after 5 attempts; another publisher is busy",
  );
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
