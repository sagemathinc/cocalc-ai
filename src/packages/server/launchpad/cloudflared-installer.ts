import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { executeCode } from "@cocalc/backend/execute-code";

// Keep in step with CLOUDFLARED_VERSION in server/cloud/bootstrap/bootstrap.py
// and EXPECTED_CLOUDFLARED_VERSION in project-host/cloudflared-diagnostics.ts.
export const CLOUDFLARED_VERSION = "2026.10.3";

const CLOUDFLARED_DOWNLOAD_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

// SHA-256 of the Linux release binaries, as published with the release and
// checked against a download. The macOS archives are checked by version only.
const CLOUDFLARED_SHA256: Record<string, string> = {
  "cloudflared-linux-amd64":
    "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0",
  "cloudflared-linux-arm64":
    "89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8",
};

// Whole download, including the body. Nothing else bounds it: the bay's
// systemd unit is Type=exec, so it counts as started before the download, and
// a stalled download would leave the tunnel down with no fallback to the
// installed binary.
const CLOUDFLARED_DOWNLOAD_TIMEOUT_MS = 45_000;

export type CloudflaredDownloadSpec = {
  filename: string;
  url: string;
  kind: "binary" | "tgz";
  sha256?: string;
};

type LoggerLike = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

function spec(
  filename: string,
  kind: CloudflaredDownloadSpec["kind"],
): CloudflaredDownloadSpec {
  const sha256 = CLOUDFLARED_SHA256[filename];
  return {
    filename,
    url: `${CLOUDFLARED_DOWNLOAD_BASE}/${filename}`,
    kind,
    ...(sha256 ? { sha256 } : {}),
  };
}

export function getCloudflaredDownloadSpec(opts?: {
  platform?: NodeJS.Platform;
  arch?: string;
}): CloudflaredDownloadSpec | undefined {
  const platform = opts?.platform ?? process.platform;
  const arch = opts?.arch ?? process.arch;
  if (platform === "darwin") {
    if (arch === "x64") return spec("cloudflared-darwin-amd64.tgz", "tgz");
    if (arch === "arm64") return spec("cloudflared-darwin-arm64.tgz", "tgz");
    return undefined;
  }
  if (platform !== "linux") {
    return undefined;
  }
  if (arch === "x64") return spec("cloudflared-linux-amd64", "binary");
  if (arch === "arm64") return spec("cloudflared-linux-arm64", "binary");
  return undefined;
}

export function localCloudflaredBinaryPath(stateDir: string): string {
  return join(stateDir, "bin", "cloudflared");
}

export function parseCloudflaredVersion(output: string): string | undefined {
  return output.match(/cloudflared version\s+([^\s(]+)/i)?.[1];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function installedVersion(path: string): Promise<string | undefined> {
  try {
    const result = await executeCode({
      command: path,
      args: ["--version"],
      timeout: 15,
      err_on_exit: false,
    });
    return parseCloudflaredVersion(
      `${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  } catch {
    return undefined;
  }
}

// Return a cloudflared binary at the pinned version under stateDir,
// downloading it when missing and replacing it when its version differs. A
// running tunnel keeps the old binary until it is restarted. If replacing an
// existing binary fails, the existing one is returned so the tunnel still
// starts; the next start tries again.
export async function ensureLocalCloudflaredBinary(opts: {
  stateDir: string;
  logger: LoggerLike;
  // For tests: the download to use instead of this platform's release file.
  spec?: CloudflaredDownloadSpec;
  downloadTimeoutMs?: number;
}): Promise<string> {
  const spec = opts.spec ?? getCloudflaredDownloadSpec();
  if (!spec) {
    throw new Error(
      `automatic cloudflared install is unsupported on ${process.platform}/${process.arch}`,
    );
  }
  const destination = localCloudflaredBinaryPath(opts.stateDir);
  if (await isExecutable(destination)) {
    const version = await installedVersion(destination);
    if (version === CLOUDFLARED_VERSION) {
      return destination;
    }
    opts.logger.info("upgrading cloudflared for launchpad", {
      installed: version ?? "unknown",
      expected: CLOUDFLARED_VERSION,
      destination,
    });
    try {
      await downloadCloudflared(
        spec,
        destination,
        opts.logger,
        opts.downloadTimeoutMs ?? CLOUDFLARED_DOWNLOAD_TIMEOUT_MS,
      );
    } catch (err) {
      (opts.logger.warn ?? opts.logger.info)(
        "cloudflared upgrade failed; keeping the installed binary",
        { installed: version ?? "unknown", err: `${err}` },
      );
    }
    return destination;
  }
  await downloadCloudflared(
    spec,
    destination,
    opts.logger,
    opts.downloadTimeoutMs ?? CLOUDFLARED_DOWNLOAD_TIMEOUT_MS,
  );
  return destination;
}

async function downloadCloudflared(
  spec: CloudflaredDownloadSpec,
  destination: string,
  logger: LoggerLike,
  timeoutMs: number,
): Promise<void> {
  const binDir = dirname(destination);
  await mkdir(binDir, { recursive: true });
  const tempPath = join(
    binDir,
    `${spec.filename}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  const stagedPath = `${tempPath}.bin`;
  logger.info("downloading cloudflared for launchpad", {
    url: spec.url,
    destination,
  });
  try {
    const response = await fetch(spec.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `download failed with ${response.status} ${response.statusText}`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (spec.sha256) {
      const actual = createHash("sha256").update(buffer).digest("hex");
      if (actual !== spec.sha256) {
        throw new Error(
          `cloudflared checksum mismatch for ${spec.filename}: expected ${spec.sha256}, got ${actual}`,
        );
      }
    }
    await writeFile(tempPath, buffer, { mode: 0o755 });
    if (spec.kind === "binary") {
      await rename(tempPath, stagedPath);
    } else {
      const extractDir = await mkdtemp(join(tmpdir(), "cocalc-cloudflared-"));
      try {
        const result = await executeCode({
          command: "tar",
          args: ["-xzf", tempPath, "-C", extractDir],
          timeout: 30,
          err_on_exit: false,
        });
        if (result.exit_code !== 0) {
          throw new Error(
            `failed to extract cloudflared archive: ${result.stderr || result.stdout || `exit code ${result.exit_code}`}`,
          );
        }
        await rename(join(extractDir, "cloudflared"), stagedPath);
      } finally {
        await rm(extractDir, { recursive: true, force: true });
      }
    }
    await chmod(stagedPath, 0o755);
    const version = await installedVersion(stagedPath);
    if (version !== CLOUDFLARED_VERSION) {
      throw new Error(
        `downloaded cloudflared reports version ${version ?? "unknown"}, expected ${CLOUDFLARED_VERSION}`,
      );
    }
    // Atomic: a running cloudflared keeps its open binary.
    await rename(stagedPath, destination);
  } finally {
    await rm(tempPath, { force: true });
    await rm(stagedPath, { force: true });
  }
}
