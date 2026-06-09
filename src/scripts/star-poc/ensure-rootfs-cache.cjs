#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { accessSync, constants } = require("node:fs");
const {
  access: accessPromise,
  mkdir,
  readFile,
  rm,
  writeFile,
} = require("node:fs/promises");
const { join } = require("node:path");

const ROOTFS_PREFLIGHT_VERSION = 11;
const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";

function log(message) {
  console.error(`[star-rootfs-cache] ${message}`);
}

function isUsableDir(dir) {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function podmanEnv() {
  const env = { ...process.env };
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const configured = env.COCALC_PODMAN_RUNTIME_DIR || env.XDG_RUNTIME_DIR;
  const userRun = typeof uid === "number" ? `/run/user/${uid}` : undefined;
  const runtimeDir =
    configured && isUsableDir(configured)
      ? configured
      : userRun && isUsableDir(userRun)
        ? userRun
        : undefined;
  if (!runtimeDir) {
    throw new Error(
      `podman requires XDG_RUNTIME_DIR; expected ${userRun ?? "a user runtime dir"}`,
    );
  }
  env.XDG_RUNTIME_DIR = runtimeDir;
  env.CONTAINERS_CGROUP_MANAGER ??= "cgroupfs";
  return env;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    log(`+ ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
      process.stderr.write(data);
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
    await accessPromise(path);
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

function preflightMetadataFilePath(image) {
  return join(
    imageCacheRoot(),
    `.${imagePathComponent(image)}.normalized.json`,
  );
}

function parsePreflightOutput(stdout) {
  const trimmed = `${stdout ?? ""}`.trim();
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Keep scanning earlier lines.
    }
  }
  return JSON.parse(trimmed);
}

function validatePreflightResult(result) {
  const distro_family = `${result?.distro_family ?? ""}`.trim();
  const package_manager = `${result?.package_manager ?? ""}`.trim();
  const shell = `${result?.shell ?? ""}`.trim();
  if (
    !["debian", "rhel", "sles", "unknown"].includes(distro_family) ||
    !["apt-get", "dnf", "microdnf", "yum", "zypper", "none"].includes(
      package_manager,
    ) ||
    !shell.startsWith("/") ||
    result?.glibc !== true ||
    typeof result?.sudo_present !== "boolean" ||
    typeof result?.ca_certificates_present !== "boolean"
  ) {
    throw new Error(
      `rootfs preflight returned an unexpected result: ${JSON.stringify(result)}`,
    );
  }
  return {
    distro_family,
    package_manager,
    shell,
    glibc: true,
    sudo_present: result.sudo_present,
    ca_certificates_present: result.ca_certificates_present,
  };
}

async function loadCurrentMetadata(image, rootfsPath, metadataPath) {
  if (!(await exists(rootfsPath)) || !(await exists(metadataPath))) return;
  if (
    !(await exists(join(rootfsPath, "home", "user"))) ||
    !(await exists(join(rootfsPath, "scratch"))) ||
    !(await exists(join(rootfsPath, "run", "secrets", "cocalc")))
  ) {
    return;
  }
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (
    metadata.version === ROOTFS_PREFLIGHT_VERSION &&
    metadata.glibc === true
  ) {
    return metadata;
  }
}

async function preflightPulledOciImage(image) {
  const script = `
set -euo pipefail
image="$1"
mnt=""
cleanup() {
  if [ -n "$mnt" ]; then
    podman image unmount "$image" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
mnt="$(podman image mount "$image")"
shell_path=""
if [ -x "$mnt/bin/bash" ]; then
  shell_path="/bin/bash"
elif [ -x "$mnt/bin/sh" ]; then
  shell_path="/bin/sh"
else
  echo "OCI image preflight failed: usable shell missing (expected /bin/bash or /bin/sh)" >&2
  exit 41
fi
has_ca_certificates() {
  [ -d "$mnt/etc/ssl/certs" ] || \
    [ -f "$mnt/etc/ssl/cert.pem" ] || \
    [ -f "$mnt/etc/pki/tls/certs/ca-bundle.crt" ] || \
    [ -f "$mnt/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem" ] || \
    [ -f "$mnt/etc/ssl/ca-bundle.pem" ]
}
sudo_present=false
if [ -x "$mnt/usr/bin/sudo" ] || [ -x "$mnt/bin/sudo" ]; then
  sudo_present=true
fi
ca_certificates_present=false
if has_ca_certificates; then
  ca_certificates_present=true
fi
distro_family="unknown"
package_manager="none"
if [ -x "$mnt/usr/bin/apt-get" ] || [ -x "$mnt/bin/apt-get" ]; then
  distro_family="debian"
  package_manager="apt-get"
elif [ -x "$mnt/usr/bin/dnf" ] || [ -x "$mnt/bin/dnf" ]; then
  distro_family="rhel"
  package_manager="dnf"
elif [ -x "$mnt/usr/bin/microdnf" ] || [ -x "$mnt/bin/microdnf" ]; then
  distro_family="rhel"
  package_manager="microdnf"
elif [ -x "$mnt/usr/bin/yum" ] || [ -x "$mnt/bin/yum" ]; then
  distro_family="rhel"
  package_manager="yum"
elif [ -x "$mnt/usr/bin/zypper" ] || [ -x "$mnt/bin/zypper" ]; then
  distro_family="sles"
  package_manager="zypper"
fi
if [ ! -e "$mnt/lib64/ld-linux-x86-64.so.2" ] && \
   [ ! -e "$mnt/lib/x86_64-linux-gnu/libc.so.6" ] && \
   [ ! -e "$mnt/lib/ld-linux-aarch64.so.1" ] && \
   [ ! -e "$mnt/lib64/ld-linux-aarch64.so.1" ] && \
   [ ! -e "$mnt/lib/aarch64-linux-gnu/libc.so.6" ]; then
  echo "OCI image preflight failed: glibc is required" >&2
  exit 43
fi
if [ "$sudo_present" = false ] || [ "$ca_certificates_present" = false ]; then
  if [ "$package_manager" = "none" ]; then
    echo "OCI image preflight failed: startup bootstrap requires sudo and CA certificates, but this image has neither a supported package manager nor the required packages preinstalled" >&2
    exit 44
  fi
fi
printf '{"ok":true,"distro_family":"%s","package_manager":"%s","shell":"%s","glibc":true,"sudo_present":%s,"ca_certificates_present":%s}\\n' \
  "$distro_family" "$package_manager" "$shell_path" "$sudo_present" "$ca_certificates_present"
`;
  const result = await run(
    "podman",
    ["unshare", "bash", "-lc", script, "cocalc-pulled-image-preflight", image],
    { env: podmanEnv() },
  );
  return validatePreflightResult(parsePreflightOutput(result.stdout));
}

async function extractImage(image, rootfsPath) {
  const script = `
set -euo pipefail
image="$1"
rootfs_path="$2"
mnt=""
cleanup() {
  if [ -n "$mnt" ]; then
    podman image unmount "$image" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
mnt="$(podman image mount "$image")"
echo "mounted at: $mnt"
mkdir -p "$rootfs_path"
rsync -aHx --numeric-ids --delete "$mnt"/ "$rootfs_path"/
`;
  await run(
    "podman",
    [
      "unshare",
      "bash",
      "-lc",
      script,
      "cocalc-rootfs-extract",
      image,
      rootfsPath,
    ],
    { env: podmanEnv() },
  );
}

async function normalizeRootfs(image, rootfsPath) {
  const result = await run("sudo", [
    "-n",
    STORAGE_WRAPPER,
    "normalize-rootfs",
    "--ownership-source",
    "oci-extract",
    rootfsPath,
  ]);
  return {
    version: ROOTFS_PREFLIGHT_VERSION,
    normalized_at: new Date().toISOString(),
    image,
    rootfs_path: rootfsPath,
    ...validatePreflightResult(parsePreflightOutput(result.stdout)),
  };
}

async function main() {
  if (process.env.COCALC_STAR_HELPER_VERIFY === "1") {
    console.log(JSON.stringify({ ok: true, helper: "ensure-rootfs-cache" }));
    return;
  }

  const image = `${process.env.STAR_DEFAULT_ROOTFS_IMAGE ?? ""}`.trim();
  if (!image) {
    throw new Error("STAR_DEFAULT_ROOTFS_IMAGE must be set");
  }

  const rootfsPath = imageCachePath(image);
  const metadataPath = preflightMetadataFilePath(image);
  const inspectPath = inspectFilePath(image);

  const cached = await loadCurrentMetadata(image, rootfsPath, metadataPath);
  if (cached) {
    log(`${image} already cached at ${rootfsPath}`);
  } else {
    await rm(rootfsPath, { force: true, recursive: true });
    await rm(metadataPath, { force: true });
    await rm(inspectPath, { force: true });

    if (!image.startsWith("containers-storage:")) {
      await run(
        "podman",
        ["--storage-opt", "ignore_chown_errors=true", "pull", image],
        { env: podmanEnv() },
      );
    }
    await preflightPulledOciImage(image);
    await mkdir(imageCacheRoot(), { recursive: true });
    const inspect = await run(
      "podman",
      ["image", "inspect", image, "--format", "{{json .}}"],
      { env: podmanEnv() },
    );
    await writeFile(inspectPath, inspect.stdout.trim() + "\n");
    await extractImage(image, rootfsPath);
    const metadata = await normalizeRootfs(image, rootfsPath);
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        image,
        cache_path: rootfsPath,
        inspect_path: inspectPath,
        preflight_path: metadataPath,
        repaired: cached == null,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
