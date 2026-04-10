import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCode } from "@cocalc/backend/execute-code";

const CLOUDFLARED_DOWNLOAD_BASE =
  "https://github.com/cloudflare/cloudflared/releases/latest/download";

export type CloudflaredDownloadSpec = {
  filename: string;
  url: string;
  kind: "binary" | "tgz";
};

type LoggerLike = {
  info: (message: string, meta?: Record<string, unknown>) => void;
};

export function getCloudflaredDownloadSpec(opts?: {
  platform?: NodeJS.Platform;
  arch?: string;
}): CloudflaredDownloadSpec | undefined {
  const platform = opts?.platform ?? process.platform;
  const arch = opts?.arch ?? process.arch;
  if (platform === "darwin") {
    if (arch === "x64") {
      return {
        filename: "cloudflared-darwin-amd64.tgz",
        url: `${CLOUDFLARED_DOWNLOAD_BASE}/cloudflared-darwin-amd64.tgz`,
        kind: "tgz",
      };
    }
    if (arch === "arm64") {
      return {
        filename: "cloudflared-darwin-arm64.tgz",
        url: `${CLOUDFLARED_DOWNLOAD_BASE}/cloudflared-darwin-arm64.tgz`,
        kind: "tgz",
      };
    }
    return undefined;
  }
  if (platform !== "linux") {
    return undefined;
  }
  if (arch === "x64") {
    return {
      filename: "cloudflared-linux-amd64",
      url: `${CLOUDFLARED_DOWNLOAD_BASE}/cloudflared-linux-amd64`,
      kind: "binary",
    };
  }
  if (arch === "arm64") {
    return {
      filename: "cloudflared-linux-arm64",
      url: `${CLOUDFLARED_DOWNLOAD_BASE}/cloudflared-linux-arm64`,
      kind: "binary",
    };
  }
  return undefined;
}

export function localCloudflaredBinaryPath(stateDir: string): string {
  return join(stateDir, "bin", "cloudflared");
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export async function ensureLocalCloudflaredBinary(opts: {
  stateDir: string;
  logger: LoggerLike;
}): Promise<string> {
  const spec = getCloudflaredDownloadSpec();
  if (!spec) {
    throw new Error(
      `automatic cloudflared install is unsupported on ${process.platform}/${process.arch}`,
    );
  }
  const destination = localCloudflaredBinaryPath(opts.stateDir);
  if (await isExecutable(destination)) {
    return destination;
  }
  const binDir = join(opts.stateDir, "bin");
  await mkdir(binDir, { recursive: true });
  const tempPath = join(
    binDir,
    `${spec.filename}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  opts.logger.info("downloading cloudflared for launchpad", {
    url: spec.url,
    destination,
  });
  try {
    const response = await fetch(spec.url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(
        `download failed with ${response.status} ${response.statusText}`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(tempPath, buffer, { mode: 0o755 });
    if (spec.kind === "binary") {
      await chmod(tempPath, 0o755);
      await rename(tempPath, destination);
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
        await rename(join(extractDir, "cloudflared"), destination);
      } finally {
        await rm(extractDir, { recursive: true, force: true });
      }
    }
    await chmod(destination, 0o755);
    return destination;
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}
