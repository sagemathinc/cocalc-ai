import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { humanSize } from "@cocalc/util/misc";

import {
  loadAuthConfig as loadDefaultAuthConfig,
  type AuthConfig,
} from "../../core/auth-config";
import { emitSuccess, printArrayTable } from "../core/cli-output";
import {
  compactTimestamp,
  chooseGeneratedTag,
  createSoftwareArtifactId,
  isSoftwareLatestSelector,
  parseSoftwareBuildComponent,
  parseSoftwareDeployComponent,
  validateSoftwareTag,
} from "../core/software/artifact-id";
import {
  artifactDir,
  copyArtifactFile,
  listLocalManifests,
  manifestToListRow,
  remoteIndexEntryToListRow,
  resolveSoftwareLocalStore,
  writeLocalManifest,
} from "../core/software/local-store";
import {
  deploymentRecordKey,
  indexKey,
  loadDefaultSoftwareR2Client,
  manifestRemoteEntry,
  publishHostCompatibilityArtifact,
  readDeploymentIndex,
  readRemoteIndex,
  resolveSoftwareRemoteConfig,
  uploadSoftwareArtifact,
  writeDeploymentRecord,
  type SoftwareRemoteIndexEntry,
  type SoftwareR2Client,
} from "../core/software/remote-store";
import type {
  SoftwareArtifactManifest,
  SoftwareBuildComponent,
  SoftwareDeployComponent,
  SoftwareDeploymentHistoryRow,
  SoftwareDeploymentIndexEntry,
  SoftwareDeploymentRecord,
  SoftwareGitMetadata,
  SoftwareListRow,
} from "../core/software/types";
import {
  SOFTWARE_BUILD_COMPONENTS,
  SOFTWARE_DEPLOY_COMPONENTS,
} from "../core/software/types";

export type SoftwareCommandDeps = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  gitMetadata?: (cwd: string) => SoftwareGitMetadata;
  runCommand?: (
    command: string,
    args: string[],
    options?: {
      stdio?: "inherit" | "pipe";
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<number>;
  r2Client?: SoftwareR2Client | (() => SoftwareR2Client);
  loadAuthConfig?: () => AuthConfig;
};

type BuildOptions = {
  localStore?: string;
  fromFile?: string;
  artifactName?: string;
  keepBuildDir?: boolean;
};

type ListOptions = {
  localStore?: string;
  limit?: string;
  remote?: boolean;
  envFile?: string;
};

type PushOptions = {
  localStore?: string;
  envFile?: string;
};

type DeployOptions = {
  localStore?: string;
  envFile?: string;
  config?: string;
  remote?: string;
  api?: string;
};

type HistoryOptions = {
  envFile?: string;
  limit?: string;
};

const BUILD_COMPONENTS_HELP = SOFTWARE_BUILD_COMPONENTS.join("|");
const DEPLOY_COMPONENTS_HELP = SOFTWARE_DEPLOY_COMPONENTS.join("|");
const BUILD_COMPONENT_ARGUMENT = `software component (${BUILD_COMPONENTS_HELP})`;
const DEPLOY_COMPONENT_ARGUMENT = `software component (${DEPLOY_COMPONENTS_HELP})`;
const KNOWN_ROCKET_REMOTES: Record<string, string> = {
  "https://staging.cocalc.ai": "ubuntu@10.206.0.27",
  "https://cocalc.ai": "ubuntu@10.206.0.38",
  "https://delta.cocalc.ai": "ubuntu@10.206.15.209",
};

function runGitText(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return `${result.stdout ?? ""}`.trim() || null;
}

function defaultGitMetadata(cwd: string): SoftwareGitMetadata {
  const commit = runGitText(cwd, ["rev-parse", "HEAD"]);
  if (!commit) {
    throw new Error(`failed to resolve git commit in ${cwd}`);
  }
  const short =
    runGitText(cwd, ["rev-parse", "--short=12", "HEAD"]) ?? commit.slice(0, 12);
  const branch = runGitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = runGitText(cwd, ["status", "--porcelain"]) ?? "";
  return {
    commit,
    short,
    branch: branch && branch !== "HEAD" ? branch : null,
    dirty: status.trim().length > 0,
    status_porcelain: status,
  };
}

function repoSrcRoot(cwd: string): string {
  return cwd.endsWith("/src") ? cwd : resolve(cwd, "src");
}

function rocketBuildInfo(component: SoftwareBuildComponent):
  | {
      script: string;
      kind: "bay-runtime" | "bay-hub" | "bay-static";
      artifactName: string;
    }
  | undefined {
  const nodeArch = process.arch === "arm64" ? "arm64" : "x64";
  if (component === "hub") {
    return {
      script: "build:bay-hub-bundle",
      kind: "bay-hub",
      artifactName: `cocalc-bay-hub-linux-${nodeArch}.tar.xz`,
    };
  }
  if (component === "bay") {
    return {
      script: "build:bay-bundle",
      kind: "bay-runtime",
      artifactName: `cocalc-bay-runtime-linux-${nodeArch}.tar.xz`,
    };
  }
  if (component === "static") {
    return {
      script: "build:bay-static-bundle",
      kind: "bay-static",
      artifactName: `cocalc-bay-static-linux-${nodeArch}.tar.xz`,
    };
  }
  return undefined;
}

function packageBuildInfo(component: SoftwareBuildComponent):
  | {
      packageFilter: string;
      script: string;
      artifactName: string;
      artifactPath: (srcRoot: string) => string;
    }
  | undefined {
  if (component === "project-host") {
    return {
      packageFilter: "@cocalc/project-host",
      script: "build:bundle",
      artifactName: "bundle-linux.tar.xz",
      artifactPath: (srcRoot) =>
        join(
          srcRoot,
          "packages",
          "project-host",
          "build",
          "bundle-linux.tar.xz",
        ),
    };
  }
  if (component === "project") {
    return {
      packageFilter: "@cocalc/project",
      script: "build:bundle",
      artifactName: "bundle-linux.tar.xz",
      artifactPath: (srcRoot) =>
        join(srcRoot, "packages", "project", "build", "bundle-linux.tar.xz"),
    };
  }
  if (component === "tools") {
    const toolsArch = process.arch === "arm64" ? "arm64" : "amd64";
    const artifactName = `tools-linux-${toolsArch}.tar.xz`;
    return {
      packageFilter: "@cocalc/project",
      script: "build:tools",
      artifactName,
      artifactPath: (srcRoot) =>
        join(srcRoot, "packages", "project", "build", artifactName),
    };
  }
  return undefined;
}

function parseLimit(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") {
    return 10;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return value;
}

function formatDurationMs(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  if (value < 1000) {
    return `${value}ms`;
  }
  const seconds = value / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function deploymentStatusForDisplay(
  status: SoftwareDeploymentIndexEntry["status"],
): string {
  return status === "started" ? "unknown" : status;
}

function formatDeployedBy(
  deployedBy: SoftwareDeploymentIndexEntry["deployed_by"],
): string {
  return (
    deployedBy.email_address ||
    deployedBy.account_id ||
    deployedBy.user ||
    "unknown"
  );
}

function formatDeployTarget(
  target: SoftwareDeploymentIndexEntry["target"],
): string {
  if (target.profile) {
    return `${target.kind}:${target.profile}`;
  }
  if (target.channel) {
    return `${target.kind}:${target.channel}`;
  }
  return target.kind;
}

function deploymentHistoryRow(
  entry: SoftwareDeploymentIndexEntry,
): SoftwareDeploymentHistoryRow {
  return {
    deployed_at: entry.started_at,
    component: entry.component,
    profile_or_channel: entry.profile_or_channel,
    artifact_id: entry.artifact_id,
    tag: entry.tag,
    git: entry.git.short,
    dirty: entry.git.dirty,
    deployed_by: formatDeployedBy(entry.deployed_by),
    target: formatDeployTarget(entry.target),
    status: deploymentStatusForDisplay(entry.status),
    duration:
      entry.duration_ms == null
        ? undefined
        : formatDurationMs(entry.duration_ms),
    error: entry.error,
    record: entry.record_url,
  };
}

function elapsedMsSince(
  startedAt: Date,
  deps: Pick<SoftwareCommandDeps, "now">,
): number {
  return Math.max(
    0,
    (deps.now?.() ?? new Date()).getTime() - startedAt.getTime(),
  );
}

async function localTagExists({
  manifests,
  tag,
}: {
  manifests: Awaited<ReturnType<typeof listLocalManifests>>;
  tag: string;
}): Promise<boolean> {
  return manifests.some(({ manifest }) => manifest.tag === tag);
}

async function buildFromFile({
  component,
  tagArg,
  opts,
  deps,
}: {
  component: SoftwareBuildComponent;
  tagArg: string | undefined;
  opts: BuildOptions;
  deps: Required<Pick<SoftwareCommandDeps, "env" | "now">> &
    Pick<SoftwareCommandDeps, "cwd" | "gitMetadata" | "runCommand">;
}): Promise<SoftwareArtifactManifest & { local_dir: string }> {
  const cwd = resolve(deps.cwd ?? process.cwd());
  const localStore = resolveSoftwareLocalStore({
    option: opts.localStore,
    env: deps.env,
  });
  const createdAt = deps.now();
  const git = deps.gitMetadata?.(cwd) ?? defaultGitMetadata(cwd);
  const existingManifests = await listLocalManifests({ localStore, component });
  const tagGenerated = tagArg == null || tagArg.trim() === "";
  const tag = tagGenerated
    ? chooseGeneratedTag({
        createdAt,
        tagExists: (candidate) =>
          existingManifests.some(({ manifest }) => manifest.tag === candidate),
      })
    : validateSoftwareTag(tagArg);
  if (
    !tagGenerated &&
    (await localTagExists({ manifests: existingManifests, tag }))
  ) {
    throw new Error(
      `software tag already exists locally for ${component}: ${tag}`,
    );
  }
  if (
    tagGenerated &&
    (await localTagExists({ manifests: existingManifests, tag }))
  ) {
    throw new Error(`generated software tag already exists locally: ${tag}`);
  }
  const startedAt = createdAt;
  const artifactId = createSoftwareArtifactId({
    createdAt,
    git,
    tag,
  });
  let buildTempDir: string | undefined;
  let sourceFile = opts.fromFile;
  let artifactName = opts.artifactName;
  let commandText = `cocalc software build ${component}${
    tagArg ? ` ${tagArg}` : ""
  }`;
  if (!sourceFile) {
    const info = rocketBuildInfo(component);
    const packageInfo = packageBuildInfo(component);
    if (!info && !packageInfo) {
      throw new Error(
        `software build ${component} is not wired yet; use --from-file <path> to create a local artifact manifest from an existing file`,
      );
    }
    if (!deps.runCommand) {
      throw new Error("software build requires runCommand dependency");
    }
    const srcRoot = repoSrcRoot(cwd);
    let args: string[];
    if (packageInfo) {
      args = [
        "-C",
        join(srcRoot, "packages"),
        "--filter",
        packageInfo.packageFilter,
        "run",
        packageInfo.script,
      ];
    } else {
      const rocketInfo = info!;
      buildTempDir = await mkdtemp(join(tmpdir(), "cocalc-software-build-"));
      const outDir = join(buildTempDir, rocketInfo.kind);
      const bundle = join(buildTempDir, rocketInfo.artifactName);
      args = [
        "-C",
        join(srcRoot, "packages"),
        "--filter",
        "@cocalc/rocket",
        "run",
        rocketInfo.script,
        outDir,
        bundle,
      ];
    }
    const code = await deps.runCommand("pnpm", args, {
      stdio: "inherit",
      env: deps.env,
    });
    if (code !== 0) {
      throw new Error(
        `software build ${component} failed with exit status ${code}`,
      );
    }
    if (packageInfo) {
      sourceFile = packageInfo.artifactPath(srcRoot);
      artifactName = packageInfo.artifactName;
    } else {
      sourceFile = args.at(-1);
      artifactName = info!.artifactName;
    }
    commandText = ["pnpm", ...args].join(" ");
  }
  const dir = artifactDir({ localStore, component, artifactId });
  const filesDir = join(dir, "files");
  try {
    if (!sourceFile) {
      throw new Error(
        `software build ${component} did not resolve an artifact`,
      );
    }
    const artifactFile = await copyArtifactFile({
      source: sourceFile,
      destinationFilesDir: filesDir,
      name: artifactName,
    });
    const finishedAt = deps.now();
    const manifest: SoftwareArtifactManifest & { local_dir: string } = {
      schema: "cocalc-software-artifact-v1",
      component,
      artifact_id: artifactId,
      tag,
      tag_generated: tagGenerated,
      created_at: createdAt.toISOString(),
      source: {
        repo_root: cwd,
        src_root: repoSrcRoot(cwd),
        branch: git.branch,
        git_commit: git.commit,
        git_short: git.short,
        git_dirty: git.dirty,
        git_status_porcelain: git.status_porcelain,
      },
      build: {
        host: hostname(),
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        command: commandText,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      },
      files: [artifactFile],
      local_dir: dir,
    };
    await writeLocalManifest({ localStore, manifest });
    return manifest;
  } finally {
    if (buildTempDir && !opts.keepBuildDir) {
      await rm(buildTempDir, { recursive: true, force: true });
    }
  }
}

function buildSummary(
  manifest: SoftwareArtifactManifest & { local_dir: string },
) {
  const totalSizeBytes = manifest.files.reduce(
    (total, file) => total + file.size_bytes,
    0,
  );
  return {
    component: manifest.component,
    tag: manifest.tag,
    tag_source: manifest.tag_generated ? "generated" : "explicit",
    artifact_id: manifest.artifact_id,
    duration: formatDurationMs(manifest.build.duration_ms),
    git: `${manifest.source.git_short} ${
      manifest.source.git_dirty ? "dirty" : "clean"
    }`,
    local: manifest.local_dir,
    size: `${humanSize(totalSizeBytes)} (${totalSizeBytes} bytes)`,
    files: manifest.files
      .map(
        (file) =>
          `${file.name} ${humanSize(file.size_bytes)} (${file.size_bytes} bytes) sha256:${file.sha256}`,
      )
      .join("\n"),
  };
}

async function resolveLocalManifestBySelector({
  localStore,
  component,
  selector,
}: {
  localStore: string;
  component: SoftwareBuildComponent;
  selector: string;
}) {
  const manifests = await listLocalManifests({ localStore, component });
  const matches = findLocalManifestMatches({ manifests, selector });
  if (matches.length === 0) {
    throw new Error(
      `local software artifact not found for ${component}: ${selector}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `local software artifact selector is ambiguous for ${component}: ${selector}`,
    );
  }
  return matches[0];
}

function findLocalManifestMatches({
  manifests,
  selector,
}: {
  manifests: Awaited<ReturnType<typeof listLocalManifests>>;
  selector: string;
}) {
  if (isSoftwareLatestSelector(selector)) {
    return manifests.slice(0, 1);
  }
  return manifests.filter(
    ({ manifest }) =>
      manifest.tag === selector || manifest.artifact_id === selector,
  );
}

function resolveSingleMatch<T>({
  matches,
  selector,
  label,
}: {
  matches: T[];
  selector: string;
  label: string;
}): T | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    throw new Error(`${label} selector is ambiguous: ${selector}`);
  }
  return matches[0];
}

function softwareR2Client(deps: SoftwareCommandDeps): SoftwareR2Client {
  if (!deps.r2Client) {
    return loadDefaultSoftwareR2Client();
  }
  return typeof deps.r2Client === "function" ? deps.r2Client() : deps.r2Client;
}

function isMissingRemoteConfigError(err: unknown): boolean {
  return `${(err as any)?.message || err}`.includes(
    "Missing R2 software credentials",
  );
}

function mergeListRows({
  localRows,
  remoteRows,
}: {
  localRows: SoftwareListRow[];
  remoteRows: SoftwareListRow[];
}): SoftwareListRow[] {
  const rows = new Map<string, SoftwareListRow>();
  for (const row of localRows) {
    rows.set(row.artifact_id, { ...row });
  }
  for (const row of remoteRows) {
    const existing = rows.get(row.artifact_id);
    if (existing) {
      existing.source =
        existing.source === "local" ? "local+remote" : existing.source;
      existing.remote = row.remote;
      continue;
    }
    rows.set(row.artifact_id, { ...row });
  }
  return [...rows.values()].sort((a, b) => b.created.localeCompare(a.created));
}

async function listRemoteRows({
  component,
  opts,
  deps,
}: {
  component: SoftwareBuildComponent;
  opts: ListOptions;
  deps: SoftwareCommandDeps;
}): Promise<SoftwareListRow[]> {
  try {
    const config = await resolveSoftwareRemoteConfig({
      env: deps.env ?? process.env,
      envFile: opts.envFile,
    });
    const client = softwareR2Client(deps);
    const index = await readRemoteIndex({
      client,
      auth: config.auth,
      component,
    });
    return index.artifacts.map(remoteIndexEntryToListRow);
  } catch (err) {
    if (isMissingRemoteConfigError(err)) {
      return [];
    }
    throw err;
  }
}

function remoteEntryMatchesSelector(
  entry: SoftwareRemoteIndexEntry,
  selector: string,
): boolean {
  return entry.tag === selector || entry.artifact_id === selector;
}

function findRemoteEntryMatches({
  entries,
  selector,
}: {
  entries: SoftwareRemoteIndexEntry[];
  selector: string;
}) {
  if (isSoftwareLatestSelector(selector)) {
    return [...entries]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 1);
  }
  return entries.filter((entry) => remoteEntryMatchesSelector(entry, selector));
}

function rocketDeployTargetForComponent(component: SoftwareDeployComponent):
  | {
      artifactComponent: SoftwareBuildComponent;
      scope: "static" | "hub" | "bay";
    }
  | undefined {
  if (component === "static") {
    return { artifactComponent: "static", scope: "static" };
  }
  if (component === "hub") {
    return { artifactComponent: "hub", scope: "hub" };
  }
  if (component === "bay") {
    return { artifactComponent: "bay", scope: "bay" };
  }
  return undefined;
}

function currentCliInvocation(): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && script.endsWith(".js")) {
    return { command: process.execPath, args: [script] };
  }
  if (
    script &&
    script !== "software" &&
    script !== "rocket" &&
    (script.includes("/") || existsSync(script))
  ) {
    return { command: script, args: [] };
  }
  return { command: process.execPath, args: [] };
}

function normalizeApiOrigin(api: string | undefined): string | undefined {
  const raw = `${api ?? ""}`.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(
      raw.startsWith("http://") || raw.startsWith("https://")
        ? raw
        : `https://${raw}`,
    );
    return url.origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function inferRocketRemote(api: string | undefined): string | undefined {
  const origin = normalizeApiOrigin(api);
  return origin ? KNOWN_ROCKET_REMOTES[origin] : undefined;
}

function resolveDeploySite({
  profile,
  opts,
  deps,
}: {
  profile: string | undefined;
  opts: DeployOptions;
  deps: SoftwareCommandDeps;
}): {
  profileName: string;
  api?: string;
  remote?: string;
  account_id?: string;
  email_address?: string;
} {
  if (opts.api && opts.remote) {
    return {
      profileName: profile ?? "explicit",
      api: opts.api,
      remote: opts.remote,
    };
  }
  const config = (deps.loadAuthConfig ?? loadDefaultAuthConfig)();
  const profileName = profile ?? config.current_profile ?? "default";
  const authProfile = config.profiles[profileName];
  const api = opts.api ?? authProfile?.api;
  const remote = opts.remote ?? inferRocketRemote(api);
  return {
    profileName,
    api,
    remote,
    account_id: authProfile?.account_id,
    email_address: authProfile?.email_address,
  };
}

function deployedBy({
  target,
  deps,
}: {
  target: ReturnType<typeof resolveDeploySite>;
  deps: SoftwareCommandDeps;
}): SoftwareDeploymentRecord["deployed_by"] {
  const env = deps.env ?? process.env;
  return {
    user: env.USER || env.LOGNAME || undefined,
    host: hostname(),
    account_id: target.account_id,
    email_address: target.email_address,
  };
}

function latestDeploySelector({
  selector,
  localManifests,
  remoteEntries,
}: {
  selector: string;
  localManifests: Awaited<ReturnType<typeof listLocalManifests>>;
  remoteEntries: SoftwareRemoteIndexEntry[];
}): string {
  if (!isSoftwareLatestSelector(selector)) {
    return selector;
  }
  const local = localManifests[0];
  const remote = [...remoteEntries].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  )[0];
  if (!local && !remote) {
    return selector;
  }
  if (
    local &&
    (!remote || local.manifest.created_at.localeCompare(remote.timestamp) >= 0)
  ) {
    return local.manifest.artifact_id;
  }
  return remote.artifact_id;
}

function remoteBundleFile(entry: SoftwareRemoteIndexEntry) {
  if (entry.files.length !== 1) {
    throw new Error(
      `software deploy expected exactly one remote file in ${entry.artifact_id}`,
    );
  }
  return entry.files[0];
}

async function resolveDeployArtifact({
  component,
  selector,
  opts,
  deps,
}: {
  component: SoftwareBuildComponent;
  selector: string;
  opts: DeployOptions;
  deps: SoftwareCommandDeps;
}): Promise<{
  tag: string;
  artifact_id: string;
  source: "local+remote" | "local+pushed" | "remote";
  remote_manifest: string;
  bundle_url: string;
  bundle_sha256: string;
  remote_entry: SoftwareRemoteIndexEntry;
}> {
  const localStore = resolveSoftwareLocalStore({
    option: opts.localStore,
    env: deps.env ?? process.env,
  });
  const localManifests = await listLocalManifests({ localStore, component });
  const config = await resolveSoftwareRemoteConfig({
    env: deps.env ?? process.env,
    envFile: opts.envFile,
  });
  const client = softwareR2Client(deps);
  const remoteIndex = await readRemoteIndex({
    client,
    auth: config.auth,
    component,
  });
  const effectiveSelector = latestDeploySelector({
    selector,
    localManifests,
    remoteEntries: remoteIndex.artifacts,
  });
  const localMatch = resolveSingleMatch({
    matches: findLocalManifestMatches({
      manifests: localManifests,
      selector: effectiveSelector,
    }),
    selector: effectiveSelector,
    label: `local software artifact for ${component}`,
  });
  let remoteEntry = resolveSingleMatch({
    matches: findRemoteEntryMatches({
      entries: remoteIndex.artifacts,
      selector: effectiveSelector,
    }),
    selector: effectiveSelector,
    label: `remote software artifact for ${component}`,
  });

  if (localMatch && !remoteEntry) {
    await uploadSoftwareArtifact({
      client,
      config,
      manifest: localMatch.manifest,
      manifestPath: localMatch.path,
      now: deps.now?.() ?? new Date(),
    });
    remoteEntry = manifestRemoteEntry({
      manifest: localMatch.manifest,
      config,
    });
    const remoteFile = remoteBundleFile(remoteEntry);
    return {
      tag: localMatch.manifest.tag,
      artifact_id: localMatch.manifest.artifact_id,
      source: "local+pushed",
      remote_manifest: remoteEntry.manifest_url,
      bundle_url: remoteFile.url,
      bundle_sha256: remoteFile.sha256,
      remote_entry: remoteEntry,
    };
  }

  if (localMatch && remoteEntry) {
    const remoteFile = remoteBundleFile(remoteEntry);
    return {
      tag: localMatch.manifest.tag,
      artifact_id: localMatch.manifest.artifact_id,
      source: "local+remote",
      remote_manifest: remoteEntry.manifest_url,
      bundle_url: remoteFile.url,
      bundle_sha256: remoteFile.sha256,
      remote_entry: remoteEntry,
    };
  }

  if (remoteEntry) {
    const remoteFile = remoteBundleFile(remoteEntry);
    return {
      tag: remoteEntry.tag,
      artifact_id: remoteEntry.artifact_id,
      source: "remote",
      remote_manifest: remoteEntry.manifest_url,
      bundle_url: remoteFile.url,
      bundle_sha256: remoteFile.sha256,
      remote_entry: remoteEntry,
    };
  }

  throw new Error(
    `software artifact not found for ${component}: ${effectiveSelector}`,
  );
}

function hostDeployArtifactForComponent(
  component: SoftwareDeployComponent,
): SoftwareBuildComponent | undefined {
  if (
    component === "project-host" ||
    component === "project" ||
    component === "tools"
  ) {
    return component;
  }
  return undefined;
}

function deploymentId({
  startedAt,
  artifactId,
}: {
  startedAt: Date;
  artifactId: string;
}): string {
  return `${compactTimestamp(startedAt)}-${artifactId}`;
}

function deploymentRecordBase({
  component,
  artifactComponent,
  profileOrChannel,
  startedAt,
  artifact,
  target,
  kind,
  details,
  deps,
}: {
  component: SoftwareDeployComponent;
  artifactComponent: SoftwareBuildComponent;
  profileOrChannel: string;
  startedAt: Date;
  artifact: Awaited<ReturnType<typeof resolveDeployArtifact>>;
  target: ReturnType<typeof resolveDeploySite>;
  kind: SoftwareDeploymentRecord["target"]["kind"];
  details?: Record<string, unknown>;
  deps: SoftwareCommandDeps;
}): SoftwareDeploymentRecord {
  const git = artifact.remote_entry.git;
  return {
    schema: "cocalc-software-deployment-v1",
    deployment_id: deploymentId({
      startedAt,
      artifactId: artifact.artifact_id,
    }),
    component,
    artifact_component: artifactComponent,
    profile_or_channel: profileOrChannel,
    started_at: startedAt.toISOString(),
    updated_at: startedAt.toISOString(),
    artifact_id: artifact.artifact_id,
    tag: artifact.tag,
    git,
    deployed_by: deployedBy({ target, deps }),
    target: {
      kind,
      profile: profileOrChannel,
      api: target.api,
      remote: target.remote,
    },
    status: "started",
    details,
  };
}

async function writeDeploymentRecordBestEffort({
  client,
  config,
  record,
  deps,
}: {
  client: SoftwareR2Client;
  config: Awaited<ReturnType<typeof resolveSoftwareRemoteConfig>>;
  record: SoftwareDeploymentRecord;
  deps: SoftwareCommandDeps;
}): Promise<void> {
  await writeDeploymentRecord({
    client,
    config,
    record,
    now: deps.now?.() ?? new Date(),
  });
}

async function runWithDeploymentHistory({
  record,
  client,
  config,
  deps,
  run,
}: {
  record: SoftwareDeploymentRecord;
  client: SoftwareR2Client;
  config: Awaited<ReturnType<typeof resolveSoftwareRemoteConfig>>;
  deps: SoftwareCommandDeps;
  run: () => Promise<void>;
}): Promise<SoftwareDeploymentRecord> {
  await writeDeploymentRecordBestEffort({ client, config, record, deps });
  try {
    await run();
  } catch (err) {
    const finishedAt = deps.now?.() ?? new Date();
    const failed: SoftwareDeploymentRecord = {
      ...record,
      updated_at: finishedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      status: "failed",
      duration_ms: Math.max(
        0,
        finishedAt.getTime() - new Date(record.started_at).getTime(),
      ),
      error: err instanceof Error ? err.message : `${err}`,
    };
    try {
      await writeDeploymentRecordBestEffort({
        client,
        config,
        record: failed,
        deps,
      });
    } catch (historyErr) {
      process.stderr.write(
        `WARNING: failed to seal software deployment failure history: ${
          historyErr instanceof Error ? historyErr.message : historyErr
        }\n`,
      );
    }
    throw err;
  }
  const finishedAt = deps.now?.() ?? new Date();
  const succeeded: SoftwareDeploymentRecord = {
    ...record,
    updated_at: finishedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    status: "succeeded",
    duration_ms: Math.max(
      0,
      finishedAt.getTime() - new Date(record.started_at).getTime(),
    ),
  };
  await writeDeploymentRecordBestEffort({
    client,
    config,
    record: succeeded,
    deps,
  });
  return succeeded;
}

export function registerSoftwareCommand(
  program: Command,
  deps: SoftwareCommandDeps = {},
): Command {
  const software = program
    .command("software")
    .description("high-level CoCalc software artifact lifecycle")
    .addHelpText(
      "after",
      `

Supported build/list/push components:
  ${BUILD_COMPONENTS_HELP}

Supported deploy/smoke components:
  ${DEPLOY_COMPONENTS_HELP}`,
    );

  software
    .command("build")
    .description("build or record a local immutable software artifact")
    .argument("<component>", BUILD_COMPONENT_ARGUMENT)
    .argument("[tag]", "optional human tag; generated if omitted")
    .option("--local-store <path>", "local artifact store")
    .option(
      "--from-file <path>",
      "record an existing artifact file in the local software store",
    )
    .option("--artifact-name <name>", "override stored artifact file name")
    .option("--keep-build-dir", "keep temporary component build directory")
    .action(
      async (
        componentArg: string,
        tagArg: string | undefined,
        opts: BuildOptions,
        command: Command,
      ) => {
        const component = parseSoftwareBuildComponent(componentArg);
        const manifest = await buildFromFile({
          component,
          tagArg,
          opts,
          deps: {
            cwd: deps.cwd,
            env: deps.env ?? process.env,
            now: deps.now ?? (() => new Date()),
            gitMetadata: deps.gitMetadata,
            runCommand: deps.runCommand,
          },
        });
        emitSuccess(
          { globals: command.optsWithGlobals() as any },
          "software build",
          buildSummary(manifest),
        );
      },
    );

  software
    .command("list")
    .alias("ls")
    .description("list local software artifacts")
    .argument("<component>", BUILD_COMPONENT_ARGUMENT)
    .option("--local-store <path>", "local artifact store")
    .option("--no-remote", "only show local artifacts")
    .option(
      "--env-file <path>",
      "R2 credential env file",
      "/run/secrets/cocalc/rocket-software-env.sh",
    )
    .option("--limit <n>", "maximum rows to show", "10")
    .action(
      async (componentArg: string, opts: ListOptions, command: Command) => {
        const component = parseSoftwareBuildComponent(componentArg);
        const localStore = resolveSoftwareLocalStore({
          option: opts.localStore,
          env: deps.env ?? process.env,
        });
        const limit = parseLimit(opts.limit);
        const localRows = (
          await listLocalManifests({ localStore, component })
        ).map(manifestToListRow);
        const remoteRows =
          opts.remote === false
            ? []
            : await listRemoteRows({ component, opts, deps });
        const rows = mergeListRows({ localRows, remoteRows }).slice(0, limit);
        const globals = command.optsWithGlobals() as any;
        if (globals.json || globals.output === "json") {
          emitSuccess({ globals }, "software list", {
            component,
            local_store: localStore,
            artifacts: rows,
          });
          return;
        }
        printArrayTable(rows);
      },
    );

  software
    .command("push")
    .description("push a local software artifact to the remote software store")
    .argument("<component>", BUILD_COMPONENT_ARGUMENT)
    .argument("<tag-or-id>", "artifact tag or id")
    .option("--local-store <path>", "local artifact store")
    .option(
      "--env-file <path>",
      "R2 credential env file",
      "/run/secrets/cocalc/rocket-software-env.sh",
    )
    .action(
      async (
        componentArg: string,
        selector: string,
        opts: PushOptions,
        command: Command,
      ) => {
        const component = parseSoftwareBuildComponent(componentArg);
        const startedAt = deps.now?.() ?? new Date();
        const localStore = resolveSoftwareLocalStore({
          option: opts.localStore,
          env: deps.env ?? process.env,
        });
        const { manifest, path } = await resolveLocalManifestBySelector({
          localStore,
          component,
          selector,
        });
        const config = await resolveSoftwareRemoteConfig({
          env: deps.env ?? process.env,
          envFile: opts.envFile,
        });
        const client = softwareR2Client(deps);
        await uploadSoftwareArtifact({
          client,
          config,
          manifest,
          manifestPath: path,
          now: deps.now?.() ?? new Date(),
        });
        const entry = manifestRemoteEntry({ manifest, config });
        emitSuccess(
          { globals: command.optsWithGlobals() as any },
          "software push",
          {
            component,
            tag: manifest.tag,
            artifact_id: manifest.artifact_id,
            duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
            remote_manifest: entry.manifest_url,
            index: `${config.publicBaseUrl}/${indexKey(component)}`,
            files: entry.files.map((file) => file.url),
          },
        );
      },
    );

  software
    .command("deploy")
    .description("deploy or promote a software artifact")
    .argument("<component>", DEPLOY_COMPONENT_ARGUMENT)
    .argument("<tag-or-id>", "artifact tag or id")
    .argument("<profile-or-channel>", "site profile or release channel")
    .option("--local-store <path>", "local artifact store")
    .option("--config <path>", "rocket config path")
    .option("--remote <ssh-target>", "bay SSH target")
    .option("--api <url>", "site API URL")
    .option(
      "--env-file <path>",
      "R2 credential env file",
      "/run/secrets/cocalc/rocket-software-env.sh",
    )
    .action(
      async (
        componentArg: string,
        selector: string,
        profileOrChannel: string | undefined,
        opts: DeployOptions,
        command: Command,
      ) => {
        const component = parseSoftwareDeployComponent(componentArg);
        const deployTarget = `${profileOrChannel ?? ""}`.trim();
        if (!deployTarget) {
          throw new Error("software deploy requires <profile-or-channel>");
        }
        const startedAt = deps.now?.() ?? new Date();
        const rocketTarget = rocketDeployTargetForComponent(component);
        const hostArtifactComponent = hostDeployArtifactForComponent(component);
        const artifactComponent =
          rocketTarget?.artifactComponent ?? hostArtifactComponent;
        if (!artifactComponent) {
          throw new Error(
            `software deploy ${component} is not wired yet; currently supported: static, hub, bay, project-host, project, tools`,
          );
        }
        if (!deps.runCommand) {
          throw new Error("software deploy requires runCommand dependency");
        }
        const artifact = await resolveDeployArtifact({
          component: artifactComponent,
          selector,
          opts,
          deps,
        });
        const target = resolveDeploySite({
          profile: deployTarget,
          opts,
          deps,
        });
        const config = await resolveSoftwareRemoteConfig({
          env: deps.env ?? process.env,
          envFile: opts.envFile,
        });
        const client = softwareR2Client(deps);
        const cli = currentCliInvocation();
        let args: string[];
        let rocketScope: string | undefined;
        let hostBaseUrl: string | undefined;
        let hostCompatUrl: string | undefined;
        let targetKind: SoftwareDeploymentRecord["target"]["kind"];
        if (rocketTarget) {
          rocketScope = rocketTarget.scope;
          targetKind = "rocket-bay";
          args = [
            ...cli.args,
            "rocket",
            "deploy",
            deployTarget,
            "--scope",
            rocketScope,
            "--bundle-url",
            artifact.bundle_url,
            "--bundle-sha256",
            artifact.bundle_sha256,
            ...(opts.config ? ["--config", opts.config] : []),
            ...(target.remote ? ["--remote", target.remote] : []),
            ...(target.api ? ["--api", target.api] : []),
            "--yes",
          ];
        } else {
          const compat = await publishHostCompatibilityArtifact({
            client,
            config,
            entry: artifact.remote_entry,
          });
          hostBaseUrl = compat.base_url;
          hostCompatUrl = compat.url;
          targetKind = "project-host-fleet";
          args = [
            ...cli.args,
            "--profile",
            deployTarget,
            "host",
            "upgrade",
            "--all-online",
            "--artifact",
            component,
            "--artifact-version",
            artifact.artifact_id,
            "--base-url",
            hostBaseUrl,
            "--wait",
          ];
        }
        const record = deploymentRecordBase({
          component,
          artifactComponent,
          profileOrChannel: deployTarget,
          startedAt,
          artifact,
          target,
          kind: targetKind,
          details: {
            source: artifact.source,
            remote_manifest: artifact.remote_manifest,
            bundle_url: artifact.bundle_url,
            bundle_sha256: artifact.bundle_sha256,
            ...(rocketScope ? { rocket_scope: rocketScope } : {}),
            ...(hostBaseUrl ? { host_software_base_url: hostBaseUrl } : {}),
            ...(hostCompatUrl ? { host_compat_url: hostCompatUrl } : {}),
          },
          deps,
        });
        const finalRecord = await runWithDeploymentHistory({
          record,
          client,
          config,
          deps,
          run: async () => {
            const code = await deps.runCommand!(cli.command, args, {
              stdio: "inherit",
              env: deps.env ?? process.env,
            });
            if (code !== 0) {
              throw new Error(
                `software deploy ${component} failed with exit status ${code}`,
              );
            }
          },
        });
        const recordKey = deploymentRecordKey({
          component,
          profileOrChannel: deployTarget,
          deploymentId: finalRecord.deployment_id,
        });
        emitSuccess(
          { globals: command.optsWithGlobals() as any },
          "software deploy",
          {
            component,
            tag: artifact.tag,
            artifact_id: artifact.artifact_id,
            duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
            source: artifact.source,
            remote_manifest: artifact.remote_manifest,
            bundle_url: artifact.bundle_url,
            bundle_sha256: artifact.bundle_sha256,
            ...(rocketScope ? { rocket_scope: rocketScope } : {}),
            ...(hostBaseUrl ? { host_software_base_url: hostBaseUrl } : {}),
            profile: deployTarget,
            deployment_id: finalRecord.deployment_id,
            deployment_record: `${config.publicBaseUrl}/${recordKey}`,
          },
        );
      },
    );

  software
    .command("history")
    .description("show deployment history for a component and profile/channel")
    .argument("<component>", DEPLOY_COMPONENT_ARGUMENT)
    .argument("<profile-or-channel>", "site profile or release channel")
    .option(
      "--env-file <path>",
      "R2 credential env file",
      "/run/secrets/cocalc/rocket-software-env.sh",
    )
    .option("--limit <n>", "maximum rows to show", "10")
    .action(
      async (
        componentArg: string,
        profileOrChannel: string,
        opts: HistoryOptions,
        command: Command,
      ) => {
        const component = parseSoftwareDeployComponent(componentArg);
        const target = `${profileOrChannel ?? ""}`.trim();
        if (!target) {
          throw new Error("software history requires <profile-or-channel>");
        }
        const limit = parseLimit(opts.limit);
        const config = await resolveSoftwareRemoteConfig({
          env: deps.env ?? process.env,
          envFile: opts.envFile,
        });
        const client = softwareR2Client(deps);
        const index = await readDeploymentIndex({
          client,
          auth: config.auth,
          component,
          profileOrChannel: target,
        });
        const rows = index.deployments
          .slice(0, limit)
          .map(deploymentHistoryRow);
        const globals = command.optsWithGlobals() as any;
        if (globals.json || globals.output === "json") {
          emitSuccess({ globals }, "software history", {
            component,
            profile_or_channel: target,
            deployments: rows,
          });
          return;
        }
        printArrayTable(rows);
      },
    );

  software
    .command("smoke")
    .description("run a software smoke test")
    .argument("<component>", DEPLOY_COMPONENT_ARGUMENT)
    .argument("[profile-or-channel]", "site profile or release channel")
    .action(() => {
      throw new Error("software smoke is not implemented yet");
    });

  return software;
}
