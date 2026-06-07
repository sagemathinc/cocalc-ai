#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { accessSync, constants } = require("node:fs");
const {
  access,
  mkdir,
  readFile,
  stat,
  writeFile,
} = require("node:fs/promises");
const { dirname, join } = require("node:path");

const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";
const DEFAULT_IMAGE_ID = "official-cocalc-star-rootfs";

function requireFallback(err, fallbackPath) {
  if (err?.code !== "MODULE_NOT_FOUND") {
    throw err;
  }
  const fullPath = join(process.cwd(), fallbackPath);
  try {
    accessSync(fullPath, constants.R_OK);
  } catch {
    throw err;
  }
  return require(fullPath);
}

function requireDatabaseDev() {
  try {
    return require("@cocalc/database/postgres/dev");
  } catch (err) {
    return requireFallback(err, "packages/database/dist/postgres/dev.js");
  }
}

function requireDatabasePool() {
  try {
    return require("@cocalc/database/pool");
  } catch (err) {
    return requireFallback(err, "packages/database/dist/pool/index.js");
  }
}

function requireRootfsReleases() {
  try {
    return require("@cocalc/server/rootfs/releases");
  } catch (err) {
    return requireFallback(err, "packages/server/dist/rootfs/releases.js");
  }
}

function requireRootfsImages() {
  try {
    return require("@cocalc/util/rootfs-images");
  } catch (err) {
    return requireFallback(err, "packages/util/dist/rootfs-images.js");
  }
}

function verifyBundledImports() {
  requireDatabaseDev();
  requireDatabasePool();
  requireRootfsReleases();
  requireRootfsImages();
  console.log(JSON.stringify({ ok: true, helper: "publish-default-rootfs" }));
}

function log(message) {
  console.error(`[star-rootfs-publish] ${message}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    log(`+ ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
      if (options.stream) process.stderr.write(data);
    });
    child.stderr.on("data", (data) => {
      stderr += data;
      process.stderr.write(data);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `'${command}' (args=${args.join(" ")}) exited with code ${code}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function imagePathComponent(image) {
  return encodeURIComponent(image);
}

function imageCacheRoot() {
  const configured = `${process.env.COCALC_IMAGE_CACHE ?? ""}`.trim();
  if (configured) return configured;
  const data = `${process.env.COCALC_DATA ?? process.env.DATA ?? ""}`.trim();
  if (!data) {
    throw new Error(
      "COCALC_DATA or DATA must be set to locate the RootFS cache",
    );
  }
  return join(data, "cache", "images");
}

function imageCachePath(image) {
  return join(imageCacheRoot(), imagePathComponent(image));
}

function inspectFilePath(image) {
  return join(imageCacheRoot(), `.${imagePathComponent(image)}.json`);
}

async function sudoStorage(args, options = {}) {
  return await run("sudo", ["-n", STORAGE_WRAPPER, ...args], options);
}

async function tarSha256(pathToHash) {
  const { stdout } = await sudoStorage(["tar-sha256-tree", pathToHash]);
  const digest = `${stdout ?? ""}`.trim();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`invalid RootFS content digest '${digest}'`);
  }
  return digest;
}

async function directorySizeBytes(pathToMeasure) {
  const { stdout } = await sudoStorage(["du-bytes", pathToMeasure]);
  const value = Number.parseInt(`${stdout ?? ""}`.trim().split(/\s+/)[0], 10);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid RootFS size for ${pathToMeasure}`);
  }
  return value;
}

function normalizeArch(value) {
  const arch = `${value ?? ""}`.trim().toLowerCase();
  if (arch === "x86_64" || arch === "amd64") return "amd64";
  if (arch === "aarch64" || arch === "arm64") return "arm64";
  return "any";
}

async function writeRepoProfile({ repo_selector, repo_toml }) {
  const data = `${process.env.COCALC_DATA ?? process.env.DATA ?? ""}`.trim();
  if (!data) {
    throw new Error("COCALC_DATA or DATA must be set to write rustic profiles");
  }
  const digest = createHash("sha256")
    .update(`${repo_selector}\0${repo_toml}`)
    .digest("hex");
  const path = join(
    data,
    "secrets",
    "rustic",
    "rootfs-images",
    `${digest}.toml`,
  );
  try {
    if ((await readFile(path, "utf8")) === repo_toml) {
      return path;
    }
  } catch {
    // write below
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, repo_toml, { encoding: "utf8", mode: 0o600 });
  return path;
}

async function backupRootfsToRustic({ sourcePath, upload, image }) {
  const repoProfile = await writeRepoProfile(upload);
  const { stdout } = await sudoStorage(
    [
      "rootfs-rustic-backup",
      sourcePath,
      repoProfile,
      image,
      "--tag",
      "rootfs-release",
      "--tag",
      "star-default-rootfs",
    ],
    {
      env: { RUSTIC_PROGRESS_INTERVAL: "1s" },
      stream: true,
    },
  );
  const parsed = JSON.parse(stdout);
  const snapshot_id = `${parsed?.id ?? ""}`.trim();
  if (!snapshot_id) {
    throw new Error("rustic backup did not return a snapshot id");
  }
  const summary = parsed?.summary ?? {};
  const packedBytes =
    Number(summary?.data_added_packed) ||
    Number(summary?.data_added) ||
    Number(summary?.total_bytes_processed) ||
    0;
  return {
    ok: true,
    backend: "rustic",
    artifact_kind: "full",
    artifact_format: "rustic",
    artifact_backend: upload.artifact_backend,
    artifact_sha256: snapshot_id,
    artifact_bytes: packedBytes,
    artifact_path: snapshot_id,
    snapshot_id,
    repo_selector: upload.repo_selector,
    repo_id: upload.repo_id,
    repo_root: upload.repo_root,
    region: upload.region,
    bucket_id: upload.bucket_id,
    bucket_name: upload.bucket_name,
    bucket_purpose: upload.bucket_purpose,
  };
}

async function setSetting(pool, name, value) {
  await pool.query(
    `INSERT INTO server_settings (name, value)
     VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value`,
    [name, value],
  );
}

async function upsertOfficialCatalogEntry({
  pool,
  image,
  release,
  digest,
  arch,
  sizeBytes,
}) {
  const sizeGb = Number((sizeBytes / 1_000_000_000).toFixed(3));
  await pool.query(
    `INSERT INTO rootfs_images
      (image_id, release_id, owner_id, runtime_image, label, family, version,
       channel, supersedes_image_id, description, visibility, official, prepull,
       hidden, hidden_at, hidden_by, blocked, blocked_reason, blocked_at,
       blocked_by, deleted, deleted_reason, deleted_at, deleted_by, arch, gpu,
       size_gb, tags, digest, content_key, deprecated, deprecated_reason, theme,
       created, updated)
     VALUES
      ($1, $2, NULL, $3, $4, $5, $6, $7, NULL, $8, 'public', true, true,
       false, NULL, NULL, false, NULL, NULL, NULL, false, NULL, NULL, NULL,
       $9, false, $10, $11::TEXT[], $12, $13, false, NULL, NULL, NOW(), NOW())
     ON CONFLICT (image_id) DO UPDATE SET
       release_id=EXCLUDED.release_id,
       runtime_image=EXCLUDED.runtime_image,
       label=EXCLUDED.label,
       family=EXCLUDED.family,
       version=EXCLUDED.version,
       channel=EXCLUDED.channel,
       description=EXCLUDED.description,
       visibility=EXCLUDED.visibility,
       official=true,
       prepull=true,
       hidden=false,
       blocked=false,
       arch=EXCLUDED.arch,
       gpu=EXCLUDED.gpu,
       size_gb=EXCLUDED.size_gb,
       tags=EXCLUDED.tags,
       digest=EXCLUDED.digest,
       content_key=EXCLUDED.content_key,
       updated=NOW()`,
    [
      DEFAULT_IMAGE_ID,
      release.release_id,
      image,
      "CoCalc Star Ubuntu 26.04",
      "ubuntu",
      "26.04",
      "star",
      "Official CoCalc Star project image with Ubuntu 26.04, LaTeX, Jupyter, pip, uv, and common scientific Python packages preinstalled.",
      arch,
      sizeGb,
      [
        "official",
        "star",
        "ubuntu-26.04",
        "latex",
        "jupyter",
        "python",
        "pip",
        "uv",
        "scipy",
      ],
      digest,
      release.content_key,
    ],
  );
}

async function ensureLocalPostgresReady() {
  if (
    process.env.COCALC_DB === "postgres" &&
    process.env.COCALC_LOCAL_POSTGRES === "1"
  ) {
    if (process.env.COCALC_LOCAL_PG_SOCKET_DIR != null) {
      process.env.PGHOST ??= process.env.COCALC_LOCAL_PG_SOCKET_DIR;
    }
    process.env.PGUSER ??= "smc";
    process.env.PGDATABASE ??= "smc";
    const { ensureLocalPostgres } = requireDatabaseDev();
    await ensureLocalPostgres({ enabled: true, logExports: false });
  }
}

async function main() {
  if (process.env.COCALC_STAR_HELPER_VERIFY === "1") {
    verifyBundledImports();
    return;
  }

  await ensureLocalPostgresReady();

  const sourceImage = `${process.env.STAR_DEFAULT_ROOTFS_IMAGE ?? ""}`.trim();
  if (!sourceImage) {
    throw new Error("STAR_DEFAULT_ROOTFS_IMAGE must be set");
  }
  const hostId =
    process.env.STAR_PROJECT_HOST_ID ?? "11111111-1111-4111-8111-111111111111";
  const cachePath = imageCachePath(sourceImage);
  if (!(await exists(cachePath))) {
    throw new Error(`default RootFS cache is missing: ${cachePath}`);
  }
  const cacheStat = await stat(cachePath);
  if (!cacheStat.isDirectory()) {
    throw new Error(`default RootFS cache is not a directory: ${cachePath}`);
  }

  const inspectPath = inspectFilePath(sourceImage);
  let inspectData = {};
  try {
    inspectData = JSON.parse(await readFile(inspectPath, "utf8"));
  } catch (err) {
    log(`unable to read RootFS inspect metadata from ${inspectPath}: ${err}`);
  }

  const digest = await tarSha256(cachePath);
  const sizeBytes = await directorySizeBytes(cachePath);
  const { managedRootfsImageName } = requireRootfsImages();
  const image = managedRootfsImageName(digest);
  const arch = normalizeArch(inspectData?.Architecture);
  const {
    issueRootfsReleaseArtifactUpload,
    loadRootfsReleaseByImage,
    upsertPublishedRootfsRelease,
  } = requireRootfsReleases();

  let release = await loadRootfsReleaseByImage(image);
  if (!release) {
    const upload = await issueRootfsReleaseArtifactUpload({
      host_id: hostId,
      source_image: sourceImage,
    });
    const uploadResult = await backupRootfsToRustic({
      sourcePath: cachePath,
      upload,
      image,
    });
    release = await upsertPublishedRootfsRelease({
      artifact: {
        image,
        content_key: digest,
        digest,
        arch,
        size_bytes: sizeBytes,
        snapshot: "star-default-rootfs",
        source_image: sourceImage,
        artifact_kind: "full",
        inspect_data: {
          ...inspectData,
          RepoTags: [image],
          Config: {
            ...(inspectData?.Config ?? {}),
            Labels: {
              ...(inspectData?.Config?.Labels ?? {}),
              "com.cocalc.rootfs.managed": "true",
              "com.cocalc.rootfs.content_key": digest,
              "com.cocalc.rootfs.source_image": sourceImage,
            },
          },
        },
        upload_result: uploadResult,
      },
      upload: uploadResult,
    });
  } else {
    log(`${image} already has release ${release.release_id}`);
  }

  const poolModule = requireDatabasePool();
  const getPool =
    poolModule.default?.default ?? poolModule.default ?? poolModule;
  if (typeof getPool !== "function") {
    throw new Error("database pool module did not export getPool");
  }
  const pool = getPool();
  await upsertOfficialCatalogEntry({
    pool,
    image,
    release,
    digest,
    arch,
    sizeBytes,
  });
  await Promise.all([
    setSetting(pool, "project_rootfs_default_image", image),
    setSetting(pool, "project_rootfs_prepull_images", image),
  ]);
  await pool.end();

  console.log(
    JSON.stringify(
      {
        ok: true,
        image,
        image_id: DEFAULT_IMAGE_ID,
        release_id: release.release_id,
        source_image: sourceImage,
        cache_path: cachePath,
        content_key: digest,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
