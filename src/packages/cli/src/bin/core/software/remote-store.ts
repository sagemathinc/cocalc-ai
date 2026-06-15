import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import type { SoftwareArtifactManifest, SoftwareBuildComponent } from "./types";

const requireCjs = createRequire(__filename);

export const DEFAULT_SOFTWARE_R2_ENV_FILE =
  "/run/secrets/cocalc/rocket-software-env.sh";

export type SoftwareR2Auth = {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
};

export type SoftwareR2Client = {
  putR2ObjectFromFile: (opts: {
    auth: SoftwareR2Auth;
    key: string;
    filePath: string;
    payloadSha256?: string;
    contentLength?: number;
    contentType?: string;
    cacheControl?: string;
  }) => Promise<void>;
  putR2ObjectFromBuffer: (opts: {
    auth: SoftwareR2Auth;
    key: string;
    body: Buffer;
    contentType?: string;
    cacheControl?: string;
  }) => Promise<void>;
  getR2ObjectBuffer: (opts: {
    auth: SoftwareR2Auth;
    key: string;
  }) => Promise<Buffer | undefined>;
};

export type SoftwareRemoteConfig = {
  auth: SoftwareR2Auth;
  publicBaseUrl: string;
  artifactCacheControl: string;
  indexCacheControl: string;
};

export type SoftwareRemoteIndexEntry = {
  artifact_id: string;
  tag: string;
  tag_generated: boolean;
  timestamp: string;
  git: {
    commit: string;
    short: string;
    dirty: boolean;
  };
  manifest_key: string;
  manifest_url: string;
  files: Array<{
    name: string;
    size_bytes: number;
    sha256: string;
    key: string;
    url: string;
  }>;
};

export type SoftwareRemoteIndex = {
  schema: "cocalc-software-index-v1";
  component: SoftwareBuildComponent;
  generated_at: string;
  artifacts: SoftwareRemoteIndexEntry[];
};

function unquoteShellValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export async function readSoftwareEnvFile(
  path: string,
): Promise<Record<string, string>> {
  if (!existsSync(path)) {
    return {};
  }
  const env: Record<string, string> = {};
  const text = await readFile(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    env[match[1]] = unquoteShellValue(match[2]);
  }
  return env;
}

function stringValue(value: unknown): string | undefined {
  const str = `${value ?? ""}`.trim();
  return str || undefined;
}

export async function resolveSoftwareRemoteConfig({
  env,
  envFile,
}: {
  env: NodeJS.ProcessEnv;
  envFile?: string;
}): Promise<SoftwareRemoteConfig> {
  const fileEnv = await readSoftwareEnvFile(
    envFile || DEFAULT_SOFTWARE_R2_ENV_FILE,
  );
  const merged = { ...fileEnv, ...env };
  const accountId = stringValue(merged.COCALC_R2_ACCOUNT_ID);
  const accessKey = stringValue(merged.COCALC_R2_ACCESS_KEY_ID);
  const secretKey = stringValue(merged.COCALC_R2_SECRET_ACCESS_KEY);
  const bucket = stringValue(merged.COCALC_R2_BUCKET);
  const publicBaseUrl = stringValue(merged.COCALC_R2_PUBLIC_BASE_URL);
  if (!accountId || !accessKey || !secretKey || !bucket || !publicBaseUrl) {
    throw new Error(
      `Missing R2 software credentials; set COCALC_R2_ACCOUNT_ID, COCALC_R2_ACCESS_KEY_ID, COCALC_R2_SECRET_ACCESS_KEY, COCALC_R2_BUCKET, and COCALC_R2_PUBLIC_BASE_URL in ${envFile || DEFAULT_SOFTWARE_R2_ENV_FILE} or the environment.`,
    );
  }
  return {
    auth: {
      endpoint:
        stringValue(merged.COCALC_R2_ENDPOINT) ||
        `https://${accountId}.r2.cloudflarestorage.com`,
      accessKey,
      secretKey,
      bucket,
      region: stringValue(merged.COCALC_R2_REGION) || "auto",
    },
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ""),
    artifactCacheControl:
      stringValue(merged.COCALC_R2_CACHE_CONTROL) ||
      "public, max-age=31536000, immutable",
    indexCacheControl:
      stringValue(merged.COCALC_R2_INDEX_CACHE_CONTROL) ||
      stringValue(merged.COCALC_R2_LATEST_CACHE_CONTROL) ||
      "public, max-age=300",
  };
}

function tryResolveBackendR2FromPackage(): string | undefined {
  try {
    return requireCjs.resolve("@cocalc/backend/r2");
  } catch {
    return undefined;
  }
}

export function resolveDefaultSoftwareR2ModulePath(
  cwd = process.cwd(),
): string {
  const packageResolved = tryResolveBackendR2FromPackage();
  if (packageResolved) {
    return packageResolved;
  }
  const candidates = [
    join(cwd, "packages", "backend", "dist", "r2.js"),
    join(cwd, "src", "packages", "backend", "dist", "r2.js"),
    resolve(__dirname, "../../../../../backend/dist/r2.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) {
    return found;
  }
  throw new Error(
    "failed to load R2 uploader: @cocalc/backend/r2 is not available and packages/backend/dist/r2.js was not found. Run `pnpm -C src/packages/backend build` or run this command from a CoCalc source checkout.",
  );
}

export function loadDefaultSoftwareR2Client(): SoftwareR2Client {
  return requireCjs(resolveDefaultSoftwareR2ModulePath()) as SoftwareR2Client;
}

export function artifactPrefix(manifest: SoftwareArtifactManifest): string {
  return `software/artifacts/${manifest.component}/${manifest.artifact_id}`;
}

export function indexKey(component: SoftwareBuildComponent): string {
  return `software/indexes/${component}.json`;
}

export function publicUrl(config: SoftwareRemoteConfig, key: string): string {
  return `${config.publicBaseUrl}/${key}`;
}

export function manifestRemoteEntry({
  manifest,
  config,
}: {
  manifest: SoftwareArtifactManifest;
  config: SoftwareRemoteConfig;
}): SoftwareRemoteIndexEntry {
  const prefix = artifactPrefix(manifest);
  const manifestKey = `${prefix}/manifest.json`;
  return {
    artifact_id: manifest.artifact_id,
    tag: manifest.tag,
    tag_generated: manifest.tag_generated,
    timestamp: manifest.created_at,
    git: {
      commit: manifest.source.git_commit,
      short: manifest.source.git_short,
      dirty: manifest.source.git_dirty,
    },
    manifest_key: manifestKey,
    manifest_url: publicUrl(config, manifestKey),
    files: manifest.files.map((file) => {
      const key = `${prefix}/${file.path}`;
      return {
        name: file.name,
        size_bytes: file.size_bytes,
        sha256: file.sha256,
        key,
        url: publicUrl(config, key),
      };
    }),
  };
}

export function emptyRemoteIndex(
  component: SoftwareBuildComponent,
): SoftwareRemoteIndex {
  return {
    schema: "cocalc-software-index-v1",
    component,
    generated_at: new Date(0).toISOString(),
    artifacts: [],
  };
}

export async function readRemoteIndex({
  client,
  auth,
  component,
}: {
  client: SoftwareR2Client;
  auth: SoftwareR2Auth;
  component: SoftwareBuildComponent;
}): Promise<SoftwareRemoteIndex> {
  try {
    const body = await client.getR2ObjectBuffer({
      auth,
      key: indexKey(component),
    });
    if (!body) {
      return emptyRemoteIndex(component);
    }
    const parsed = JSON.parse(body.toString("utf8"));
    if (
      parsed?.schema !== "cocalc-software-index-v1" ||
      parsed?.component !== component ||
      !Array.isArray(parsed?.artifacts)
    ) {
      throw new Error(`invalid remote software index for ${component}`);
    }
    return parsed;
  } catch (err: any) {
    const message = `${err?.message || err}`;
    if (err?.statusCode === 404 || /\b404\b|not found/i.test(message)) {
      return emptyRemoteIndex(component);
    }
    throw err;
  }
}

export async function uploadSoftwareArtifact({
  client,
  config,
  manifest,
  manifestPath,
  now,
}: {
  client: SoftwareR2Client;
  config: SoftwareRemoteConfig;
  manifest: SoftwareArtifactManifest;
  manifestPath: string;
  now: Date;
}): Promise<SoftwareRemoteIndex> {
  const current = await readRemoteIndex({
    client,
    auth: config.auth,
    component: manifest.component,
  });
  if (
    current.artifacts.some(
      (entry) =>
        entry.artifact_id === manifest.artifact_id ||
        entry.tag === manifest.tag,
    )
  ) {
    throw new Error(
      `remote software artifact already exists for ${manifest.component}: ${manifest.tag}`,
    );
  }
  const prefix = artifactPrefix(manifest);
  const localDir = join(manifestPath, "..");
  for (const file of manifest.files) {
    const key = `${prefix}/${file.path}`;
    await client.putR2ObjectFromFile({
      auth: config.auth,
      key,
      filePath: join(localDir, file.path),
      payloadSha256: file.sha256,
      contentLength: file.size_bytes,
      contentType: file.content_type,
      cacheControl: config.artifactCacheControl,
    });
    await client.putR2ObjectFromBuffer({
      auth: config.auth,
      key: `${key}.sha256`,
      body: Buffer.from(`${file.sha256}  ${file.name}\n`, "utf8"),
      contentType: "text/plain",
      cacheControl: config.artifactCacheControl,
    });
  }
  await client.putR2ObjectFromBuffer({
    auth: config.auth,
    key: `${prefix}/manifest.json`,
    body: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"),
    contentType: "application/json",
    cacheControl: config.artifactCacheControl,
  });
  const entry = manifestRemoteEntry({ manifest, config });
  const next: SoftwareRemoteIndex = {
    schema: "cocalc-software-index-v1",
    component: manifest.component,
    generated_at: now.toISOString(),
    artifacts: [entry, ...current.artifacts],
  };
  await client.putR2ObjectFromBuffer({
    auth: config.auth,
    key: indexKey(manifest.component),
    body: Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8"),
    contentType: "application/json",
    cacheControl: config.indexCacheControl,
  });
  return next;
}
