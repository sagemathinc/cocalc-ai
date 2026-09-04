/*
Download a ripgrep or fd binary for the operating system

This supports x86_64/arm64 linux & macos

This assumes tar is installed.

NOTE: There are several npm modules that purport to install ripgrep.  We do not use
https://www.npmjs.com/package/@vscode/ripgrep because it is not properly maintained,
e.g.,
  - security vulnerabilities: https://github.com/microsoft/ripgrep-prebuilt/issues/48
  - not updated to a major new release without a good reason: https://github.com/microsoft/ripgrep-prebuilt/issues/38

NOTE: there is a linux program "upx", which can be run on any of these binaries,
which makes them self-extracting executables.
The binaries become less than half their size, but startup time is typically
increased to about 100ms to do the decompression every time.  We're not currently
using this, but it could be useful in some contexts, maybe.   The main value in
these programs isn't that they are small, but that:

- they are all statically linked, so run anywhere (e.g., in any container)
- they are fast (newer, in rust/go) often using parallelism well
*/

import { arch, platform } from "os";
import { split } from "@cocalc/util/misc";
import { execFileSync, execSync } from "child_process";
import { executeCode } from "@cocalc/backend/execute-code";
import { writeFile, stat, unlink, mkdir, chmod } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
// using old version of pkg-dir because of nextjs :-(
import { sync as packageDirectorySync } from "pkg-dir";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("files:sandbox:install");

const SYSTEM_BIN_PATH = "/opt/cocalc/tools/current";
const INSTALL_MAX_RETRIES = 3;
const INSTALL_RETRY_DELAY_MS = 2000;

function hasBinary(dir: string | undefined, name: string): boolean {
  if (!dir) return false;
  try {
    return existsSync(join(dir, name));
  } catch {
    return false;
  }
}

function resolveBinPath(): string {
  const envPath = process.env.COCALC_BIN_PATH;
  if (envPath) {
    return envPath;
  }
  if (
    hasBinary(SYSTEM_BIN_PATH, "rg") &&
    hasBinary(SYSTEM_BIN_PATH, "fd") &&
    hasBinary(SYSTEM_BIN_PATH, "jq")
  ) {
    return SYSTEM_BIN_PATH;
  }
  return join(
    packageDirectorySync(__dirname) ?? "/tmp",
    "node_modules",
    ".bin",
  );
}

// Prefer explicit override so tests/bundled environments can point to the
// correct toolchain even when package resolution lands elsewhere.
const binPath = resolveBinPath();
const systemBinPathInUse =
  !process.env.COCALC_BIN_PATH && binPath === SYSTEM_BIN_PATH;

const overridePlatform = process.env.COCALC_TOOL_PLATFORM;
const overrideArch = process.env.COCALC_TOOL_ARCH;

function effectivePlatform(): NodeJS.Platform {
  return (overridePlatform as NodeJS.Platform) ?? platform();
}

function normalizeArch(value: string): string {
  switch (value) {
    case "amd64":
    case "x86_64":
      return "x64";
    case "aarch64":
      return "arm64";
    default:
      return value;
  }
}

function isCrossBuild(): boolean {
  if (overridePlatform && overridePlatform !== platform()) {
    return true;
  }
  if (overrideArch && normalizeArch(overrideArch) !== arch()) {
    return true;
  }
  return false;
}

function effectiveArch(): string {
  return normalizeArch(overrideArch ?? arch());
}

type CodexBinary = "codex" | "codex-code-mode-host";
type CodexArch = "x64" | "arm64";

const CODEX_RELEASE_SHA256: Record<CodexArch, Record<CodexBinary, string>> = {
  x64: {
    codex: "e8cd1160071f725d2a10cab81073dd6818fc8b096372125d27ef6e66fdf0979e",
    "codex-code-mode-host":
      "177a4507b9cc7f97f113ac034697b39f6a71a876a8bd508ff6d7f52f342ebe4a",
  },
  arm64: {
    codex: "878693f9b370320ea21793f99ea1f5687b7d9aa1f2c733de693d9ec0baa4e62a",
    "codex-code-mode-host":
      "70fe485e6919a038b75f70be71aa5782a19a5f36ee85597301e90bd1c9bcbf07",
  },
};

function getCodexArch(): CodexArch {
  if (effectivePlatform() !== "linux") {
    throw Error(`unsupported codex platform ${effectivePlatform()}`);
  }
  const currentArch = effectiveArch();
  if (currentArch !== "x64" && currentArch !== "arm64") {
    throw Error(`unsupported codex arch ${currentArch}`);
  }
  return currentArch;
}

function getCodexReleaseAssetName(
  binary: CodexBinary,
  currentArch: CodexArch,
): string {
  const upstreamArch = currentArch === "x64" ? "x86_64" : "aarch64";
  return `${binary}-${upstreamArch}-unknown-linux-musl.tar.gz`;
}

function getCodexInstallScript(version: string): string {
  const releaseBase = `https://github.com/openai/codex/releases/download/rust-v${version}`;
  const currentArch = getCodexArch();
  const binaries = ["codex", "codex-code-mode-host"] as const;
  const paths = Object.fromEntries(
    binaries.map((binary) => [binary, join(binPath, binary)]),
  );
  const archives = Object.fromEntries(
    binaries.map((binary) => [binary, `${paths[binary]}.tar.gz.tmp`]),
  );
  const downloads = binaries.flatMap((binary) => {
    const assetName = getCodexReleaseAssetName(binary, currentArch);
    const extractedName = assetName.slice(0, -".tar.gz".length);
    return [
      `curl -fL "${releaseBase}/${assetName}" -o "${archives[binary]}"`,
      `printf '%s  %s\\n' "${CODEX_RELEASE_SHA256[currentArch][binary]}" "${archives[binary]}" | sha256sum -c -`,
      `tar -xOzf "${archives[binary]}" "${extractedName}" > "${paths[binary]}.tmp"`,
    ];
  });
  return [
    `rm -f "${paths.codex}.tmp" "${paths["codex-code-mode-host"]}.tmp" "${archives.codex}" "${archives["codex-code-mode-host"]}"`,
    ...downloads,
    `rm -f "${archives.codex}" "${archives["codex-code-mode-host"]}"`,
    `chmod a+x "${paths.codex}.tmp" "${paths["codex-code-mode-host"]}.tmp"`,
    `mv "${paths["codex-code-mode-host"]}.tmp" "${paths["codex-code-mode-host"]}"`,
    `mv "${paths.codex}.tmp" "${paths.codex}"`,
  ].join(" && ");
}

const BLIT_VERSION = "0.55.1";
const BLIT_LICENSE_SHA256 =
  "bd48ff0dc768d8a2425e852d1f242be474b00f4f9a0d982a007ce4f89d5691fa";
const OPENH264_CRATE_VERSION = "0.9.7";
const OPENH264_CRATE_SHA256 =
  "75a8867e48183bbd9147380227448c065fe456eb30b0ebc68929809c36c30985";
const BLIT_SHA256 = {
  arm64: "6e49a9c58a344d8018603ce3d1aea208acf4954e9086a53035cc2d3572e0eb36",
  x64: "95964bc0d1ad61c8c1cb5755fd06f341a3365ddb985477e108ebc84e0bcacb9d",
} as const;

const XWAYLAND_SATELLITE_VERSION = "v0.8.2";
const XWAYLAND_SATELLITE_RELEASE = "v0.8.2-cocalc.2";
const XWAYLAND_SATELLITE_SHA256 = {
  arm64: "5ce4ebee0df7ba2f7e43d5533f2c0b0c9f41043d63a618faf1099f3299b64872",
  x64: "8989aee33baf15f4e73e4c7f68aacadf218978e1282108cb66c5ca97bda58b4c",
} as const;

function graphicalToolArch(): keyof typeof BLIT_SHA256 {
  const currentArch = effectiveArch();
  if (currentArch !== "x64" && currentArch !== "arm64") {
    throw Error(`unsupported graphical tool arch ${currentArch}`);
  }
  return currentArch;
}

function getBlitInstallScript(): string {
  const currentArch = graphicalToolArch();
  const releaseArch = currentArch === "x64" ? "x86_64" : "aarch64";
  const archive = `blit_${BLIT_VERSION}_linux_${releaseArch}.tar.gz`;
  const releaseBase = `https://github.com/indent-com/blit/releases/download/v${BLIT_VERSION}`;
  const licenseUrl =
    "https://raw.githubusercontent.com/indent-com/blit/05002b31cbe429b3198b528e3cb2a0f6a068c750/LICENSE";
  const openh264Archive = `openh264-sys2-${OPENH264_CRATE_VERSION}.crate`;
  const openh264Url = `https://static.crates.io/crates/openh264-sys2/${openh264Archive}`;
  const prefix = join(binPath, "..");
  const licenseDir = join(prefix, "share", "licenses", "blit");
  const target = join(binPath, "blit");
  return [
    "set -eu",
    'tmp="$(mktemp -d)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    `curl -fL "${releaseBase}/${archive}" -o "$tmp/${archive}"`,
    `printf '%s  %s\\n' "${BLIT_SHA256[currentArch]}" "$tmp/${archive}" | sha256sum -c -`,
    `mkdir -p "${binPath}" "${licenseDir}"`,
    `tar -xzf "$tmp/${archive}" -C "$tmp" bin/blit`,
    `curl -fL "${licenseUrl}" -o "$tmp/LICENSE"`,
    `printf '%s  %s\\n' "${BLIT_LICENSE_SHA256}" "$tmp/LICENSE" | sha256sum -c -`,
    `install -m 0644 "$tmp/LICENSE" "${licenseDir}/LICENSE"`,
    `curl -fL "${openh264Url}" -o "$tmp/${openh264Archive}"`,
    `printf '%s  %s\\n' "${OPENH264_CRATE_SHA256}" "$tmp/${openh264Archive}" | sha256sum -c -`,
    `tar -xzf "$tmp/${openh264Archive}" -C "$tmp" "openh264-sys2-${OPENH264_CRATE_VERSION}/upstream/LICENSE"`,
    `install -m 0644 "$tmp/openh264-sys2-${OPENH264_CRATE_VERSION}/upstream/LICENSE" "${licenseDir}/OPENH264-LICENSE"`,
    `printf '%s\\n' 'Blit ${BLIT_VERSION} (non-GPL OpenH264 build)' 'Source: https://github.com/indent-com/blit/tree/05002b31cbe429b3198b528e3cb2a0f6a068c750' 'Binary: ${releaseBase}/${archive}' 'OpenH264 source crate: ${openh264Url}' > "${licenseDir}/SOURCE"`,
    `install -m 0755 "$tmp/bin/blit" "${target}"`,
  ].join("; ");
}

function getXwaylandSatelliteInstallScript(): string {
  const currentArch = graphicalToolArch();
  const releaseArch = currentArch === "x64" ? "x86_64" : "aarch64";
  const archive = `xwayland-satellite-${XWAYLAND_SATELLITE_VERSION}-linux-${releaseArch}.tar.xz`;
  const archiveRoot = archive.slice(0, -".tar.xz".length);
  const releaseBase = `https://github.com/sagemathinc/xwayland-satellite-builds/releases/download/${XWAYLAND_SATELLITE_RELEASE}`;
  const prefix = join(binPath, "..");
  const licenseDir = join(prefix, "share", "licenses", "xwayland-satellite");
  const target = join(binPath, "xwayland-satellite");
  return [
    "set -eu",
    'tmp="$(mktemp -d)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    `curl -fL "${releaseBase}/${archive}" -o "$tmp/${archive}"`,
    `printf '%s  %s\\n' "${XWAYLAND_SATELLITE_SHA256[currentArch]}" "$tmp/${archive}" | sha256sum -c -`,
    `mkdir -p "${binPath}" "${licenseDir}"`,
    `tar -xJf "$tmp/${archive}" -C "$tmp"`,
    `install -m 0644 "$tmp/${archiveRoot}/share/licenses/xwayland-satellite/LICENSE" "${licenseDir}/LICENSE"`,
    `install -m 0644 "$tmp/${archiveRoot}/share/licenses/xwayland-satellite/SOURCE" "${licenseDir}/SOURCE"`,
    `install -m 0755 "$tmp/${archiveRoot}/bin/xwayland-satellite" "${target}"`,
  ].join("; ");
}

interface Spec {
  nonFatal?: boolean; // true if failure to install is non-fatal
  VERSION?: string;
  BASE?: string;
  binary?: string;
  path: string;
  stripComponents?: number;
  pathInArchive?: () => string;
  skip?: string[];
  script?: () => string;
  platforms?: string[];
  fix?: string;
  url?: () => string;
  // if given, a bash shell line to run whose LAST output
  // (split by whitespace) is the version
  getVersion: string;
}

export const SPEC = {
  rg: {
    // See https://github.com/BurntSushi/ripgrep/releases
    VERSION: "14.1.1",
    BASE: "https://github.com/BurntSushi/ripgrep/releases/download",
    binary: "rg",
    path: join(binPath, "rg"),
    getVersion: "rg --version | head -n 1 | awk '{ print $2 }'",
    url: () =>
      `${SPEC.rg.BASE}/${SPEC.rg.VERSION}/ripgrep-${SPEC.rg.VERSION}-${getOS()}.tar.gz`,
    pathInArchive: () =>
      `ripgrep-${SPEC.rg.VERSION}-${getOS()}/${SPEC.rg.binary}`,
  },
  fd: {
    // See https://github.com/sharkdp/fd/releases
    VERSION: "v10.2.0",
    getVersion: `fd --version | awk '{print "v"$2}'`,
    BASE: "https://github.com/sharkdp/fd/releases/download",
    binary: "fd",
    path: join(binPath, "fd"),
  },
  jq: {
    // See https://github.com/jqlang/jq/releases
    VERSION: "jq-1.8.1",
    getVersion: "jq --version",
    BASE: "https://github.com/jqlang/jq/releases/download",
    binary: "jq",
    path: join(binPath, "jq"),
    platforms: ["linux", "darwin"],
    script: () => {
      const platformName =
        effectivePlatform() === "darwin" ? "macos" : effectivePlatform();
      const archName = effectiveArch() === "x64" ? "amd64" : effectiveArch();
      const url = `${SPEC.jq.BASE}/${SPEC.jq.VERSION}/jq-${platformName}-${archName}`;
      return `curl -fL "${url}" -o "${SPEC.jq.path}" && chmod a+x "${SPEC.jq.path}"`;
    },
  },
  dust: {
    // See https://github.com/bootandy/dust/releases
    VERSION: "v1.2.3",
    getVersion: `dust --version | awk '{print "v"$2}'`,
    BASE: "https://github.com/bootandy/dust/releases/download",
    binary: "dust",
    path: join(binPath, "dust"),
    // github binaries exists for x86 mac only, which is dead - in homebrew.
    platforms: ["linux"],
  },
  ouch: {
    // See https://github.com/ouch-org/ouch/releases
    VERSION: "0.6.1",
    getVersion: "ouch --version",
    BASE: "https://github.com/ouch-org/ouch/releases/download",
    binary: "ouch",
    path: join(binPath, "ouch"),
    // See https://github.com/ouch-org/ouch/issues/45; note that ouch is in home brew
    // for this platform.
    platforms: ["linux"],
    url: () => {
      const os = getOS();
      return `${SPEC.ouch.BASE}/${SPEC.ouch.VERSION}/ouch-${os}.tar.gz`;
    },
    pathInArchive: () => `ouch-${getOS()}/${SPEC.ouch.binary}`,
  },
  rustic: {
    // See https://github.com/sagemathinc/rustic/releases
    VERSION: "0.11.1",
    getVersion: "rustic --version",
    BASE: "https://github.com/sagemathinc/rustic/releases/download/v0.11.1",
    binary: "rustic",
    path: join(binPath, "rustic"),
    platforms: ["linux"],
    stripComponents: 0,
    pathInArchive: () => "rustic",
    url: () => {
      const archName = effectiveArch() === "x64" ? "x86_64" : "arm64";
      return `${SPEC.rustic.BASE}/rustic-v${SPEC.rustic.VERSION}-linux-${archName}.tar.gz`;
    },
  },
  restServer: {
    // See https://github.com/restic/rest-server/releases
    VERSION: "0.14.0",
    getVersion: "rest-server --version | awk '{print $2}'",
    BASE: "https://github.com/restic/rest-server/releases/download",
    binary: "rest-server",
    path: join(binPath, "rest-server"),
    platforms: ["linux"],
    stripComponents: 1,
    url: () => {
      const a = effectiveArch() === "x64" ? "amd64" : effectiveArch();
      return `${SPEC.restServer.BASE}/v${SPEC.restServer.VERSION}/rest-server_${SPEC.restServer.VERSION}_linux_${a}.tar.gz`;
    },
    pathInArchive: () =>
      `rest-server_${SPEC.restServer.VERSION}_linux_${effectiveArch() === "x64" ? "amd64" : effectiveArch()}/${SPEC.restServer.binary}`,
  },
  // sshpiper -- used by the project-host
  // See https://github.com/sagemathinc/sshpiper-binaries/releases
  sshpiper: {
    optional: false,
    desc: "sshpiper reverse proxy for sshd",
    path: join(binPath, "sshpiperd"),
    // this is what --version outputs and is the sha hash of HEAD:
    VERSION: "7fdd88982",
    getVersion: "sshpiperd --version | awk '{print $4}' | cut -c 1-9",
    script: () => {
      // this is the actual version in our release page
      const VERSION = "v1.5.0";
      const a = effectiveArch() == "x64" ? "amd64" : effectiveArch();
      return `curl -L https://github.com/sagemathinc/sshpiper-binaries/releases/download/${VERSION}/sshpiper-${VERSION}-${effectivePlatform()}-${a}.tar.xz | tar -xJ -C "${binPath}" --strip-components=1`;
    },
    url: () => {
      const VERSION = SPEC.sshpiper.VERSION;
      // https://github.com/sagemathinc/sshpiper-binaries/releases/download/v1.5.0/sshpiper-v1.5.0-darwin-amd64.tar.xz
      return `sshpiper-${VERSION}-${arch() == "x64" ? "amd64" : arch()}.tar.xz`;
    },
    BASE: "https://github.com/sagemathinc/sshpiper-binaries/releases",
  },
  // https://github.com/openai/codex/releases
  codex: {
    optional: false,
    desc: "codex",
    path: join(binPath, "codex"),
    getVersion: "codex --version | awk '{print $2}'",
    VERSION: "0.153.2",
    platforms: ["linux"],
    script: () => getCodexInstallScript(SPEC.codex.VERSION),
    BASE: "https://github.com/openai/codex/releases",
  },
  blit: {
    optional: false,
    desc: "Blit browser compositor",
    path: join(binPath, "blit"),
    getVersion: "blit --version | awk '{print $2}'",
    VERSION: BLIT_VERSION,
    platforms: ["linux"],
    script: getBlitInstallScript,
    BASE: "https://github.com/indent-com/blit/releases",
  },
  xwaylandSatellite: {
    optional: false,
    desc: "Xwayland compatibility bridge for Blit",
    path: join(binPath, "xwayland-satellite"),
    getVersion: "xwayland-satellite -version",
    VERSION: XWAYLAND_SATELLITE_VERSION,
    platforms: ["linux"],
    script: getXwaylandSatelliteInstallScript,
    BASE: "https://github.com/sagemathinc/xwayland-satellite-builds/releases",
  },
  btm: {
    optional: true,
    // See https://github.com/ClementTsang/bottom/releases
    VERSION: "0.11.1",
    getVersion: "btm --version",
    BASE: "https://github.com/ClementTsang/bottom/releases/download",
    platforms: ["linux"],
    binary: "btm",
    script: () => {
      const VERSION = SPEC.btm.VERSION;
      const url = `${SPEC.btm.BASE}/${VERSION}/bottom_${getOS()}.tar.gz`;
      return `curl -L ${url} | tar -xz -C ${binPath} btm`;
    },
    path: join(binPath, "btm"),
  },

  dropbear: {
    desc: "Dropbear Statically Linked SSH Server ",
    platforms: ["linux"],
    VERSION: "v2025.88",
    getVersion: "dropbear -V",
    path: join(binPath, "dropbear"),
    // we grab just the dropbear binary out of the release; we don't
    // need any of the others:
    script: () => {
      const archName = effectiveArch() === "x64" ? "x86_64" : "aarch64";
      return `curl -L https://github.com/sagemathinc/dropbear/releases/download/main/dropbear-${archName}-linux-musl.tar.xz | tar -xJ -C ${binPath} --strip-components=1 dropbear-${archName}-linux-musl/dropbear`;
    },
  },
  // See https://github.com/moparisthebest/static-curl/releases
  //
  // https://github.com/moparisthebest/static-curl/releases/download/v8.11.0/curl-amd64
  // https://github.com/moparisthebest/static-curl/releases/download/v8.11.0/curl-aarch64
  // This can be really *BAD* to install, due to required security certs
  curl: {
    optional: true,
    desc: "statically linked curl",
    path: join(binPath, "curl"),
    platforms: ["linux"],
    getVersion: "curl --version | head -n 1 | cut -f 2 -d ' '",
    VERSION: "8.11.0",
    script: () => {
      const a = arch() == "x64" ? "amd64" : "aarch64";
      return `curl -L https://github.com/moparisthebest/static-curl/releases/download/v${SPEC.curl.VERSION}/curl-${a} > ${join(binPath, "curl")} && chmod a+x ${join(binPath, "curl")}`;
    },
  },

  // See https://github.com/sagemathinc/bees-binaries/releases
  bees: {
    desc: "Bees dedup binary for Ubuntu with minimal deps",
    path: join(binPath, "bees"),
    platforms: ["linux"],
    VERSION: "2024-10-04a",
    // https://github.com/sagemathinc/bees-binaries/releases/download/2024-10-04a/bees-2024-10-04a-x86_64-linux-glibc.tar.xz
    script: () => {
      const a = effectiveArch() === "x64" ? "x86_64" : "aarch64";
      const name = `bees-${SPEC.bees.VERSION}-${a}-linux-glibc`;
      return `curl -L https://github.com/sagemathinc/bees-binaries/releases/download/${SPEC.bees.VERSION}/${name}.tar.xz | tar -xJ -C ${binPath} --strip-components=2 ${name}/bin/bees`;
    },
  },
};

export const rg = SPEC.rg.path;
export const fd = SPEC.fd.path;
export const jq = SPEC.jq.path;
export const dust = SPEC.dust.path;
export const rustic = SPEC.rustic.path;
export const restServer = SPEC.restServer.path;
export const ouch = SPEC.ouch.path;
export const sshpiper = SPEC.sshpiper.path;
export const blit = SPEC.blit.path;
export const xwaylandSatellite = SPEC.xwaylandSatellite.path;
export const btm = SPEC.btm.path;
export const dropbear = SPEC.dropbear.path;
export const curl = SPEC.curl.path;

type App = keyof typeof SPEC;

// https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-x86_64-unknown-linux-musl.tar.gz
// https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz

export async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function installedVersion(app: App): Promise<string | undefined> {
  const { path, getVersion } = SPEC[app] as Spec;
  if (!(await exists(path))) {
    return;
  }
  if (!getVersion) {
    return;
  }
  try {
    const { stdout, stderr } = await executeCode({
      verbose: true,
      command: getVersion,
      env: { ...process.env, PATH: binPath + ":/usr/bin:" + process.env.PATH },
    });
    const v = split(stdout + stderr)
      .slice(-1)[0]
      .trim();
    return v;
  } catch (err) {
    logger.debug("WARNING: issue getting version", { path, getVersion, err });
  }
  return;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function versions() {
  const v: { [app: string]: string | undefined } = {};
  await Promise.all(
    Object.keys(SPEC).map(async (app) => {
      v[app] = await installedVersion(app as App);
    }),
  );
  return v;
}

export async function alreadyInstalled(app: App) {
  const { path, VERSION } = SPEC[app] as Spec;
  if (!(await exists(path))) {
    return false;
  }
  if (
    app === "codex" &&
    !(await exists(join(binPath, "codex-code-mode-host")))
  ) {
    return false;
  }
  if (isCrossBuild()) {
    return true;
  }
  const v = await installedVersion(app);
  if (v == null) {
    // no version info
    return true;
  }
  return v == VERSION;
}

async function installOnce(app: App, spec: Spec) {
  const { script } = spec;
  if (script != null) {
    const s = script();
    console.log(`Running '${s}' in ${process.cwd()}`);
    if (!(await exists(process.cwd()))) {
      await mkdir(process.cwd(), { recursive: true });
    }

    try {
      execSync(s);
    } catch (err) {
      if (spec.fix) {
        console.warn(`BUILD OF ${app} FAILED: Suggested fix -- ${spec.fix}`);
      }
      throw err;
    }
    if (isCrossBuild()) {
      if (!(await exists(spec.path))) {
        throw Error(`failed to install ${app}`);
      }
    } else if (!(await alreadyInstalled(app))) {
      throw Error(`failed to install ${app}`);
    }
    return;
  }

  if (!(await exists(binPath))) {
    await mkdir(binPath, { recursive: true });
  }

  const url = getUrl(app);
  if (!url) {
    logger.debug("install: skipping ", app);
    return;
  }
  logger.debug("install", { app, url });
  // - 1. Fetch the tarball from the github url (using the fetch library)
  const response = await downloadFromGithub(url);
  const tarballBuffer = Buffer.from(await response.arrayBuffer());

  // - 2. Extract the file "rg" from the tarball to ${__dirname}/rg
  // The tarball contains this one file "rg" at the top level, i.e., for
  //   ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz
  // we have "tar tvf ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz" outputs
  //    ...
  //    ripgrep-14.1.1-x86_64-unknown-linux-musl/rg

  const { VERSION, binary, path, stripComponents = 1, pathInArchive } = spec;

  const archivePath =
    pathInArchive?.() ?? `${app}-${VERSION}-${getOS()}/${binary}`;

  const tmpFile = join(__dirname, `${app}-${VERSION}.tar.gz`);
  try {
    await writeFile(tmpFile, tarballBuffer);
    // sync is fine since this is run at *build time*.
    execFileSync("tar", [
      "xzf",
      tmpFile,
      `--strip-components=${stripComponents}`,
      `-C`,
      binPath,
      archivePath,
    ]);

    // - 3. Make the file executable
    await chmod(path, 0o755);
  } finally {
    try {
      await unlink(tmpFile);
    } catch {}
  }
}

export async function install(
  app?: App,
  { optional }: { optional?: boolean } = {},
) {
  if (systemBinPathInUse) {
    return;
  }
  if (!(await exists(binPath))) {
    await mkdir(binPath, { recursive: true });
  }
  if (app == null) {
    // @ts-ignore
    await Promise.all(
      Object.keys(SPEC)
        .filter((x) => optional || !SPEC[x].optional)
        .map((x) => install(x as App, { optional })),
    );
    return;
  }

  if (await alreadyInstalled(app)) {
    return;
  }

  const spec = SPEC[app] as Spec;

  if (
    spec.platforms != null &&
    !spec.platforms?.includes(effectivePlatform())
  ) {
    return;
  }

  try {
    for (let attempt = 1; attempt <= INSTALL_MAX_RETRIES + 1; attempt++) {
      try {
        await installOnce(app, spec);
        return;
      } catch (err) {
        if (attempt === INSTALL_MAX_RETRIES + 1) {
          throw err;
        }
        const waitMs = INSTALL_RETRY_DELAY_MS * attempt;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `Install of ${app} failed on attempt ${attempt}/${INSTALL_MAX_RETRIES + 1}: ${message}. Retrying in ${waitMs}ms (retry ${attempt}/${INSTALL_MAX_RETRIES}).`,
        );
        await delay(waitMs);
      }
    }
  } catch (err) {
    if (spec.nonFatal) {
      console.log(`WARNING: unable to install ${app}`, err);
    } else {
      throw err;
    }
  }
}

// Download from github, but aware of rate limits, the retry-after header, etc.
async function downloadFromGithub(url: string) {
  const maxRetries = 10;
  const baseDelay = 1000; // 1 second

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);

      if (res.status === 429) {
        // Rate limit error
        if (attempt === maxRetries) {
          throw new Error("Rate limit exceeded after max retries");
        }

        const retryAfter = res.headers.get("retry-after");
        const delay = retryAfter
          ? parseInt(retryAfter) * 1000
          : baseDelay * Math.pow(2, attempt - 1); // Exponential backoff

        console.log(
          `Rate limited. Retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return res;
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }

      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(
        `Fetch ${url} failed. Retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Should not reach here");
}

function getUrl(app: App) {
  const spec = SPEC[app] as Spec;
  if (spec.url != null) {
    return spec.url();
  }
  const { BASE, VERSION, skip } = spec;
  const os = getOS();
  if (skip?.includes(os)) {
    return "";
  }
  // very common pattern with rust cli tools:
  return `${BASE}/${VERSION}/${app}-${VERSION}-${os}.tar.gz`;
}

function getOS() {
  switch (effectivePlatform()) {
    case "linux":
      switch (effectiveArch()) {
        case "x64":
          return "x86_64-unknown-linux-musl";
        case "arm64":
          return "aarch64-unknown-linux-gnu";
        default:
          throw Error(`unsupported arch '${effectiveArch()}'`);
      }
    case "darwin":
      switch (effectiveArch()) {
        case "x64":
          return "x86_64-apple-darwin";
        case "arm64":
          return "aarch64-apple-darwin";
        default:
          throw Error(`unsupported arch '${effectiveArch()}'`);
      }
    default:
      throw Error(`unsupported platform '${effectivePlatform()}'`);
  }
}
