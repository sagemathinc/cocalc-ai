import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  copyR2Object,
  getR2ObjectBuffer,
  putR2ObjectFromBuffer,
  putR2ObjectFromFile,
} from "@cocalc/backend/r2";
import type {
  SoftwareArtifactManifest,
  SoftwareBuildComponent,
  SoftwareDeployComponent,
  SoftwareDeploymentIndex,
  SoftwareDeploymentIndexEntry,
  SoftwareDeploymentRecord,
} from "./types";

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
  copyR2Object: (opts: {
    auth: SoftwareR2Auth;
    sourceKey: string;
    destKey: string;
  }) => Promise<void>;
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

export type SoftwareReleaseChannel = "dev" | "candidate" | "stable";

export type SoftwareReleaseChannelManifest = {
  schema: "cocalc-software-release-channel-v1";
  product: "cocalc" | "cocalc-launchpad" | "cocalc-plus";
  component: "cli" | "launchpad" | "plus";
  channel: SoftwareReleaseChannel | "latest";
  artifact_id: string;
  tag: string;
  created_at: string;
  published_at: string;
  git: {
    commit: string;
    short: string;
    dirty: boolean;
  };
  os: "linux" | "darwin";
  arch: "amd64" | "arm64";
  filename: string;
  size_bytes: number;
  sha256: string;
  url: string;
  version: string;
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

export function loadDefaultSoftwareR2Client(): SoftwareR2Client {
  return {
    putR2ObjectFromFile,
    putR2ObjectFromBuffer,
    getR2ObjectBuffer,
    copyR2Object,
  };
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

function keySegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, "%252F");
}

export function deploymentIndexKey({
  component,
  profileOrChannel,
}: {
  component: SoftwareDeployComponent;
  profileOrChannel: string;
}): string {
  return `software/deployments/${keySegment(profileOrChannel)}/${component}/index.json`;
}

export function deploymentRecordKey({
  component,
  profileOrChannel,
  deploymentId,
}: {
  component: SoftwareDeployComponent;
  profileOrChannel: string;
  deploymentId: string;
}): string {
  return `software/deployments/${keySegment(profileOrChannel)}/${component}/${deploymentId}.json`;
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

export function emptyDeploymentIndex({
  component,
  profileOrChannel,
}: {
  component: SoftwareDeployComponent;
  profileOrChannel: string;
}): SoftwareDeploymentIndex {
  return {
    schema: "cocalc-software-deployment-index-v1",
    component,
    profile_or_channel: profileOrChannel,
    generated_at: new Date(0).toISOString(),
    deployments: [],
  };
}

export async function readDeploymentIndex({
  client,
  auth,
  component,
  profileOrChannel,
}: {
  client: SoftwareR2Client;
  auth: SoftwareR2Auth;
  component: SoftwareDeployComponent;
  profileOrChannel: string;
}): Promise<SoftwareDeploymentIndex> {
  try {
    const body = await client.getR2ObjectBuffer({
      auth,
      key: deploymentIndexKey({ component, profileOrChannel }),
    });
    if (!body) {
      return emptyDeploymentIndex({ component, profileOrChannel });
    }
    const parsed = JSON.parse(body.toString("utf8"));
    if (
      parsed?.schema !== "cocalc-software-deployment-index-v1" ||
      parsed?.component !== component ||
      parsed?.profile_or_channel !== profileOrChannel ||
      !Array.isArray(parsed?.deployments)
    ) {
      throw new Error(
        `invalid software deployment index for ${component}/${profileOrChannel}`,
      );
    }
    return parsed;
  } catch (err: any) {
    const message = `${err?.message || err}`;
    if (err?.statusCode === 404 || /\b404\b|not found/i.test(message)) {
      return emptyDeploymentIndex({ component, profileOrChannel });
    }
    throw err;
  }
}

export function deploymentIndexEntry({
  record,
  config,
}: {
  record: SoftwareDeploymentRecord;
  config: SoftwareRemoteConfig;
}): SoftwareDeploymentIndexEntry {
  const record_key = deploymentRecordKey({
    component: record.component,
    profileOrChannel: record.profile_or_channel,
    deploymentId: record.deployment_id,
  });
  return {
    deployment_id: record.deployment_id,
    component: record.component,
    artifact_component: record.artifact_component,
    profile_or_channel: record.profile_or_channel,
    started_at: record.started_at,
    updated_at: record.updated_at,
    finished_at: record.finished_at,
    artifact_id: record.artifact_id,
    tag: record.tag,
    git: record.git,
    deployed_by: record.deployed_by,
    target: record.target,
    status: record.status,
    duration_ms: record.duration_ms,
    error: record.error,
    record_key,
    record_url: publicUrl(config, record_key),
  };
}

export async function writeDeploymentRecord({
  client,
  config,
  record,
  now,
}: {
  client: SoftwareR2Client;
  config: SoftwareRemoteConfig;
  record: SoftwareDeploymentRecord;
  now: Date;
}): Promise<SoftwareDeploymentIndex> {
  const current = await readDeploymentIndex({
    client,
    auth: config.auth,
    component: record.component,
    profileOrChannel: record.profile_or_channel,
  });
  const recordKey = deploymentRecordKey({
    component: record.component,
    profileOrChannel: record.profile_or_channel,
    deploymentId: record.deployment_id,
  });
  await client.putR2ObjectFromBuffer({
    auth: config.auth,
    key: recordKey,
    body: Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8"),
    contentType: "application/json",
    cacheControl: config.indexCacheControl,
  });
  const entry = deploymentIndexEntry({ record, config });
  const deployments = [
    entry,
    ...current.deployments.filter(
      (candidate) => candidate.deployment_id !== record.deployment_id,
    ),
  ].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const next: SoftwareDeploymentIndex = {
    schema: "cocalc-software-deployment-index-v1",
    component: record.component,
    profile_or_channel: record.profile_or_channel,
    generated_at: now.toISOString(),
    deployments,
  };
  await client.putR2ObjectFromBuffer({
    auth: config.auth,
    key: deploymentIndexKey({
      component: record.component,
      profileOrChannel: record.profile_or_channel,
    }),
    body: Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8"),
    contentType: "application/json",
    cacheControl: config.indexCacheControl,
  });
  return next;
}

export async function publishHostCompatibilityArtifact({
  client,
  config,
  entry,
}: {
  client: SoftwareR2Client;
  config: SoftwareRemoteConfig;
  entry: SoftwareRemoteIndexEntry;
}): Promise<{ base_url: string; urls: string[] }> {
  const artifact = entry.manifest_key.split("/")[2] as
    | "project-host"
    | "project"
    | "tools";
  if (
    !["project-host", "project", "tools"].includes(artifact) ||
    (artifact !== "tools" && entry.files.length !== 1) ||
    entry.files.length < 1
  ) {
    throw new Error(
      `software host compatibility publish expected project-host/project to have one file and tools to have one or more files in ${entry.artifact_id}`,
    );
  }
  const urls: string[] = [];
  for (const file of entry.files) {
    const compatKey = `software/${artifact}/${entry.artifact_id}/${file.name}`;
    await client.copyR2Object({
      auth: config.auth,
      sourceKey: file.key,
      destKey: compatKey,
    });
    await client.putR2ObjectFromBuffer({
      auth: config.auth,
      key: `${compatKey}.sha256`,
      body: Buffer.from(`${file.sha256}  ${file.name}\n`, "utf8"),
      contentType: "text/plain",
      cacheControl: config.artifactCacheControl,
    });
    urls.push(publicUrl(config, compatKey));
  }
  return {
    base_url: `${config.publicBaseUrl}/software`,
    urls,
  };
}

function releaseProductForComponent(
  component: SoftwareBuildComponent,
): SoftwareReleaseChannelManifest["product"] | undefined {
  if (component === "cli") return "cocalc";
  if (component === "launchpad") return "cocalc-launchpad";
  if (component === "plus") return "cocalc-plus";
  return undefined;
}

function isReleaseComponent(
  component: SoftwareBuildComponent,
): component is SoftwareReleaseChannelManifest["component"] {
  return (
    component === "cli" || component === "launchpad" || component === "plus"
  );
}

function normalizeReleaseMachine(
  machine: string,
): SoftwareReleaseChannelManifest["arch"] | undefined {
  if (machine === "x86_64" || machine === "amd64" || machine === "x64") {
    return "amd64";
  }
  if (machine === "aarch64" || machine === "arm64") {
    return "arm64";
  }
  return undefined;
}

function releaseFilePlatform({
  component,
  fileName,
}: {
  component: "cli" | "launchpad" | "plus";
  fileName: string;
}): {
  os: SoftwareReleaseChannelManifest["os"];
  arch: SoftwareReleaseChannelManifest["arch"];
} {
  const prefix =
    component === "cli"
      ? "cocalc-cli-"
      : component === "launchpad"
        ? "cocalc-launchpad-"
        : "cocalc-plus-";
  if (!fileName.startsWith(prefix)) {
    throw new Error(
      `release channel file for ${component} must start with ${prefix}: ${fileName}`,
    );
  }
  const withoutArchive = fileName.replace(/\.tar\.xz$|\.xz$/, "");
  const parts = withoutArchive.slice(prefix.length).split("-");
  const os = parts.at(-1);
  const arch = normalizeReleaseMachine(parts.at(-2) ?? "");
  if ((os !== "linux" && os !== "darwin") || !arch) {
    throw new Error(
      `release channel file for ${component} must end in <machine>-<os>: ${fileName}`,
    );
  }
  return { os, arch };
}

export function validateSoftwareReleaseChannel(
  raw: string,
): SoftwareReleaseChannel {
  const channel = raw.trim();
  if (channel === "dev" || channel === "candidate" || channel === "stable") {
    return channel;
  }
  if (channel === "latest") {
    throw new Error(
      "software deploy channel 'latest' is a compatibility alias; deploy to 'stable' instead",
    );
  }
  throw new Error(
    `unsupported software release channel '${raw}'; expected dev, candidate, or stable`,
  );
}

function releaseChannelManifestKey({
  product,
  channel,
  os,
  arch,
}: {
  product: SoftwareReleaseChannelManifest["product"];
  channel: SoftwareReleaseChannelManifest["channel"];
  os: SoftwareReleaseChannelManifest["os"];
  arch: SoftwareReleaseChannelManifest["arch"];
}): string {
  return `software/${product}/${channel}-${os}-${arch}.json`;
}

function releaseChannelManifest({
  component,
  product,
  channel,
  entry,
  file,
  publishedAt,
}: {
  component: "cli" | "launchpad" | "plus";
  product: SoftwareReleaseChannelManifest["product"];
  channel: SoftwareReleaseChannelManifest["channel"];
  entry: SoftwareRemoteIndexEntry;
  file: SoftwareRemoteIndexEntry["files"][number];
  publishedAt: Date;
}): SoftwareReleaseChannelManifest {
  const { os, arch } = releaseFilePlatform({ component, fileName: file.name });
  return {
    schema: "cocalc-software-release-channel-v1",
    product,
    component,
    channel,
    artifact_id: entry.artifact_id,
    tag: entry.tag,
    created_at: entry.timestamp,
    published_at: publishedAt.toISOString(),
    git: entry.git,
    os,
    arch,
    filename: file.name,
    size_bytes: file.size_bytes,
    sha256: file.sha256,
    url: file.url,
    version: entry.artifact_id,
  };
}

export async function publishReleaseChannelArtifact({
  client,
  config,
  entry,
  channel,
  now,
}: {
  client: SoftwareR2Client;
  config: SoftwareRemoteConfig;
  entry: SoftwareRemoteIndexEntry;
  channel: SoftwareReleaseChannel;
  now: Date;
}): Promise<{
  product: SoftwareReleaseChannelManifest["product"];
  channel: SoftwareReleaseChannel;
  manifests: Array<{
    key: string;
    url: string;
    manifest: SoftwareReleaseChannelManifest;
  }>;
}> {
  const component = entry.manifest_key.split("/")[2] as SoftwareBuildComponent;
  const product = releaseProductForComponent(component);
  if (!product || !isReleaseComponent(component)) {
    throw new Error(
      `software release channel publish does not support ${component}`,
    );
  }
  if (entry.files.length < 1) {
    throw new Error(
      `software release channel publish expected at least one file in ${entry.artifact_id}`,
    );
  }
  const aliases: Array<SoftwareReleaseChannel | "latest"> =
    channel === "stable" ? ["stable", "latest"] : [channel];
  const published: Array<{
    key: string;
    url: string;
    manifest: SoftwareReleaseChannelManifest;
  }> = [];
  for (const alias of aliases) {
    for (const file of entry.files) {
      const manifest = releaseChannelManifest({
        component,
        product,
        channel: alias,
        entry,
        file,
        publishedAt: now,
      });
      const key = releaseChannelManifestKey({
        product,
        channel: alias,
        os: manifest.os,
        arch: manifest.arch,
      });
      await client.putR2ObjectFromBuffer({
        auth: config.auth,
        key,
        body: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"),
        contentType: "application/json",
        cacheControl: config.indexCacheControl,
      });
      published.push({ key, url: publicUrl(config, key), manifest });
    }
  }
  return { product, channel, manifests: published };
}
