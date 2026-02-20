import basePath from "@cocalc/backend/base-path";
import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, basename, delimiter, resolve } from "node:path";
import { getLogger } from "../../logger";

type BundleArtifact = "project-host" | "project" | "tools";

type FileMeta = {
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
};

const logger = getLogger("hub:software-endpoint");
const fileMetaCache = new Map<string, FileMeta>();
const normalizedBasePath = basePath === "/" ? "" : basePath;
const SAFE_PLATFORM_TOKEN = /^[A-Za-z0-9._-]{1,64}$/;

function softwareBaseFromReq(req: Request): string {
  return `${req.protocol}://${req.get("host")}${normalizedBasePath}/software`;
}

function localSoftwarePackagesRoots(): string[] {
  const configured =
    process.env.COCALC_PROJECT_HOST_SOFTWARE_PACKAGES_ROOT ?? "";
  const roots = configured
    .split(delimiter)
    .map((x) => x.trim())
    .filter(Boolean);
  roots.push(
    resolve(process.cwd(), "src/packages"),
    resolve(process.cwd(), "packages"),
    resolve(__dirname, "../../../../../packages"),
    resolve(__dirname, "../../../../../../packages"),
  );
  return [...new Set(roots)];
}

function looksLikePackagesRoot(root: string): boolean {
  return (
    existsSync(join(root, "project-host", "build", "bundle-linux.tar.xz")) &&
    existsSync(join(root, "project", "build", "bundle-linux.tar.xz"))
  );
}

function resolvePackagesRoot(): string | undefined {
  const roots = localSoftwarePackagesRoots();
  for (const root of roots) {
    if (looksLikePackagesRoot(root)) return root;
  }
  return undefined;
}

function resolveBundlePath(
  packagesRoot: string,
  artifact: BundleArtifact,
  os: string,
  arch?: string,
): string | undefined {
  if (!SAFE_PLATFORM_TOKEN.test(os)) return undefined;
  if (arch != null && !SAFE_PLATFORM_TOKEN.test(arch)) return undefined;
  if (artifact === "project-host" || artifact === "project") {
    const file = join(packagesRoot, artifact, "build", `bundle-${os}.tar.xz`);
    return existsSync(file) ? file : undefined;
  }
  if (!arch) return undefined;
  const archAliases =
    arch === "amd64"
      ? ["amd64", "x64"]
      : arch === "arm64"
        ? ["arm64", "aarch64"]
        : [arch];
  const candidates: string[] = [];
  for (const a of archAliases) {
    candidates.push(`tools-${os}-${a}.tar.xz`);
    candidates.push(`tools-minimal-${os}-${a}.tar.xz`);
  }
  for (const name of candidates) {
    const file = join(packagesRoot, "project", "build", name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

function resolveBootstrapPath(packagesRoot: string): string | undefined {
  const file = join(packagesRoot, "server", "cloud", "bootstrap", "bootstrap.py");
  return existsSync(file) ? file : undefined;
}

async function getFileMeta(filePath: string): Promise<FileMeta> {
  const s = await stat(filePath);
  const key = `${filePath}:${s.size}:${s.mtimeMs}`;
  const cached = fileMetaCache.get(key);
  if (cached) return cached;
  const buf = await readFile(filePath);
  const meta: FileMeta = {
    sizeBytes: s.size,
    mtimeMs: s.mtimeMs,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
  fileMetaCache.set(key, meta);
  return meta;
}

function versionFromMeta(meta: FileMeta): string {
  return String(Math.floor(meta.mtimeMs));
}

function sendNotFound(res: Response, message: string): void {
  res.status(404).json({ error: message });
}

function sendShaResponse(res: Response, sha256: string, filename: string): void {
  res.type("text/plain");
  res.send(`${sha256}  ${filename}\n`);
}

function validatePlatformTokens(
  res: Response,
  opts: { os: string; arch?: string },
): boolean {
  if (!SAFE_PLATFORM_TOKEN.test(opts.os)) {
    sendNotFound(res, "invalid os selector");
    return false;
  }
  if (opts.arch != null && !SAFE_PLATFORM_TOKEN.test(opts.arch)) {
    sendNotFound(res, "invalid arch selector");
    return false;
  }
  return true;
}

async function sendLatestBundleManifest(
  req: Request,
  res: Response,
  opts: { artifact: BundleArtifact; os: string; arch?: string },
): Promise<void> {
  if (!validatePlatformTokens(res, opts)) return;
  const packagesRoot = resolvePackagesRoot();
  if (!packagesRoot) {
    sendNotFound(
      res,
      "local software artifacts are unavailable (set COCALC_PROJECT_HOST_SOFTWARE_PACKAGES_ROOT)",
    );
    return;
  }
  const bundlePath = resolveBundlePath(
    packagesRoot,
    opts.artifact,
    opts.os,
    opts.arch,
  );
  if (!bundlePath) {
    sendNotFound(
      res,
      `missing local artifact for ${opts.artifact} (${opts.os}${
        opts.arch ? `-${opts.arch}` : ""
      })`,
    );
    return;
  }
  const meta = await getFileMeta(bundlePath);
  const version = versionFromMeta(meta);
  const filename = basename(bundlePath);
  const url = `${softwareBaseFromReq(req)}/${opts.artifact}/${version}/${filename}`;
  const manifest: Record<string, string | number> = {
    url,
    sha256: meta.sha256,
    size_bytes: meta.sizeBytes,
    built_at: new Date(meta.mtimeMs).toISOString(),
    version,
    os: opts.os,
  };
  if (opts.arch) {
    manifest.arch = opts.arch;
  }
  res.type("application/json");
  res.send(JSON.stringify(manifest, null, 2));
}

async function sendBundleFile(
  _req: Request,
  res: Response,
  opts: { artifact: BundleArtifact; os: string; arch?: string; version: string },
): Promise<void> {
  if (!validatePlatformTokens(res, opts)) return;
  const packagesRoot = resolvePackagesRoot();
  if (!packagesRoot) {
    sendNotFound(
      res,
      "local software artifacts are unavailable (set COCALC_PROJECT_HOST_SOFTWARE_PACKAGES_ROOT)",
    );
    return;
  }
  const bundlePath = resolveBundlePath(
    packagesRoot,
    opts.artifact,
    opts.os,
    opts.arch,
  );
  if (!bundlePath) {
    sendNotFound(
      res,
      `missing local artifact for ${opts.artifact} (${opts.os}${
        opts.arch ? `-${opts.arch}` : ""
      })`,
    );
    return;
  }
  const meta = await getFileMeta(bundlePath);
  const expectedVersion = versionFromMeta(meta);
  if (opts.version !== expectedVersion) {
    sendNotFound(
      res,
      `version ${opts.version} is not available for ${opts.artifact}; latest is ${expectedVersion}`,
    );
    return;
  }
  res.sendFile(bundlePath);
}

async function sendBundleSha(
  _req: Request,
  res: Response,
  opts: { artifact: BundleArtifact; os: string; arch?: string; version: string },
): Promise<void> {
  if (!validatePlatformTokens(res, opts)) return;
  const packagesRoot = resolvePackagesRoot();
  if (!packagesRoot) {
    sendNotFound(
      res,
      "local software artifacts are unavailable (set COCALC_PROJECT_HOST_SOFTWARE_PACKAGES_ROOT)",
    );
    return;
  }
  const bundlePath = resolveBundlePath(
    packagesRoot,
    opts.artifact,
    opts.os,
    opts.arch,
  );
  if (!bundlePath) {
    sendNotFound(
      res,
      `missing local artifact for ${opts.artifact} (${opts.os}${
        opts.arch ? `-${opts.arch}` : ""
      })`,
    );
    return;
  }
  const meta = await getFileMeta(bundlePath);
  const expectedVersion = versionFromMeta(meta);
  if (opts.version !== expectedVersion) {
    sendNotFound(
      res,
      `version ${opts.version} is not available for ${opts.artifact}; latest is ${expectedVersion}`,
    );
    return;
  }
  sendShaResponse(res, meta.sha256, basename(bundlePath));
}

async function sendBootstrapFile(_req: Request, res: Response): Promise<void> {
  const packagesRoot = resolvePackagesRoot();
  if (!packagesRoot) {
    sendNotFound(
      res,
      "local software artifacts are unavailable (set COCALC_PROJECT_HOST_SOFTWARE_PACKAGES_ROOT)",
    );
    return;
  }
  const filePath = resolveBootstrapPath(packagesRoot);
  if (!filePath) {
    sendNotFound(res, "missing bootstrap.py in local source tree");
    return;
  }
  res.sendFile(filePath);
}

async function sendBootstrapSha(_req: Request, res: Response): Promise<void> {
  const packagesRoot = resolvePackagesRoot();
  if (!packagesRoot) {
    sendNotFound(
      res,
      "local software artifacts are unavailable (set COCALC_PROJECT_HOST_SOFTWARE_PACKAGES_ROOT)",
    );
    return;
  }
  const filePath = resolveBootstrapPath(packagesRoot);
  if (!filePath) {
    sendNotFound(res, "missing bootstrap.py in local source tree");
    return;
  }
  const meta = await getFileMeta(filePath);
  sendShaResponse(res, meta.sha256, basename(filePath));
}

export default function init(router: Router) {
  router.get("/software/project-host/latest-:os.json", async (req, res) => {
    try {
      await sendLatestBundleManifest(req, res, {
        artifact: "project-host",
        os: req.params.os,
      });
    } catch (err) {
      logger.error("software manifest error (project-host)", { err: String(err) });
      sendNotFound(res, "failed creating project-host manifest");
    }
  });

  router.get("/software/project/latest-:os.json", async (req, res) => {
    try {
      await sendLatestBundleManifest(req, res, {
        artifact: "project",
        os: req.params.os,
      });
    } catch (err) {
      logger.error("software manifest error (project)", { err: String(err) });
      sendNotFound(res, "failed creating project manifest");
    }
  });

  router.get("/software/tools/latest-:os-:arch.json", async (req, res) => {
    try {
      await sendLatestBundleManifest(req, res, {
        artifact: "tools",
        os: req.params.os,
        arch: req.params.arch,
      });
    } catch (err) {
      logger.error("software manifest error (tools)", { err: String(err) });
      sendNotFound(res, "failed creating tools manifest");
    }
  });

  router.get("/software/project-host/:version/bundle-:os.tar.xz", async (req, res) => {
    try {
      await sendBundleFile(req, res, {
        artifact: "project-host",
        version: req.params.version,
        os: req.params.os,
      });
    } catch (err) {
      logger.error("software artifact error (project-host)", { err: String(err) });
      sendNotFound(res, "failed serving project-host bundle");
    }
  });

  router.get(
    "/software/project-host/:version/bundle-:os.tar.xz.sha256",
    async (req, res) => {
      try {
        await sendBundleSha(req, res, {
          artifact: "project-host",
          version: req.params.version,
          os: req.params.os,
        });
      } catch (err) {
        logger.error("software sha error (project-host)", { err: String(err) });
        sendNotFound(res, "failed serving project-host checksum");
      }
    },
  );

  router.get("/software/project/:version/bundle-:os.tar.xz", async (req, res) => {
    try {
      await sendBundleFile(req, res, {
        artifact: "project",
        version: req.params.version,
        os: req.params.os,
      });
    } catch (err) {
      logger.error("software artifact error (project)", { err: String(err) });
      sendNotFound(res, "failed serving project bundle");
    }
  });

  router.get(
    "/software/project/:version/bundle-:os.tar.xz.sha256",
    async (req, res) => {
      try {
        await sendBundleSha(req, res, {
          artifact: "project",
          version: req.params.version,
          os: req.params.os,
        });
      } catch (err) {
        logger.error("software sha error (project)", { err: String(err) });
        sendNotFound(res, "failed serving project checksum");
      }
    },
  );

  router.get("/software/tools/:version/tools-:os-:arch.tar.xz", async (req, res) => {
    try {
      await sendBundleFile(req, res, {
        artifact: "tools",
        version: req.params.version,
        os: req.params.os,
        arch: req.params.arch,
      });
    } catch (err) {
      logger.error("software artifact error (tools)", { err: String(err) });
      sendNotFound(res, "failed serving tools bundle");
    }
  });

  router.get(
    "/software/tools/:version/tools-:os-:arch.tar.xz.sha256",
    async (req, res) => {
      try {
        await sendBundleSha(req, res, {
          artifact: "tools",
          version: req.params.version,
          os: req.params.os,
          arch: req.params.arch,
        });
      } catch (err) {
        logger.error("software sha error (tools)", { err: String(err) });
        sendNotFound(res, "failed serving tools checksum");
      }
    },
  );

  router.get("/software/bootstrap/:selector/bootstrap.py", async (req, res) => {
    try {
      await sendBootstrapFile(req, res);
    } catch (err) {
      logger.error("software bootstrap error", { err: String(err) });
      sendNotFound(res, "failed serving bootstrap.py");
    }
  });

  router.get(
    "/software/bootstrap/:selector/bootstrap.py.sha256",
    async (req, res) => {
      try {
        await sendBootstrapSha(req, res);
      } catch (err) {
        logger.error("software bootstrap sha error", { err: String(err) });
        sendNotFound(res, "failed serving bootstrap.py checksum");
      }
    },
  );

  logger.info("local software routes enabled", {
    basePath: `${normalizedBasePath}/software`,
    packagesRoot: resolvePackagesRoot() ?? null,
  });
}
