import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";

import { emitSuccess, printArrayTable } from "../core/cli-output";
import {
  chooseGeneratedTag,
  createSoftwareArtifactId,
  parseSoftwareBuildComponent,
  validateSoftwareTag,
} from "../core/software/artifact-id";
import {
  artifactDir,
  copyArtifactFile,
  listLocalManifests,
  manifestToListRow,
  resolveSoftwareLocalStore,
  writeLocalManifest,
} from "../core/software/local-store";
import {
  indexKey,
  loadDefaultSoftwareR2Client,
  manifestRemoteEntry,
  resolveSoftwareRemoteConfig,
  uploadSoftwareArtifact,
  type SoftwareR2Client,
} from "../core/software/remote-store";
import type {
  SoftwareArtifactManifest,
  SoftwareBuildComponent,
  SoftwareGitMetadata,
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
};

type PushOptions = {
  localStore?: string;
  envFile?: string;
};

const BUILD_COMPONENTS_HELP = SOFTWARE_BUILD_COMPONENTS.join("|");
const DEPLOY_COMPONENTS_HELP = SOFTWARE_DEPLOY_COMPONENTS.join("|");
const BUILD_COMPONENT_ARGUMENT = `software component (${BUILD_COMPONENTS_HELP})`;
const DEPLOY_COMPONENT_ARGUMENT = `software component (${DEPLOY_COMPONENTS_HELP})`;

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
      kind: "bay-runtime" | "bay-static";
      artifactName: string;
    }
  | undefined {
  const nodeArch = process.arch === "arm64" ? "arm64" : "x64";
  if (component === "hub") {
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
  return {
    component: manifest.component,
    tag: manifest.tag,
    tag_source: manifest.tag_generated ? "generated" : "explicit",
    artifact_id: manifest.artifact_id,
    git: `${manifest.source.git_short} ${
      manifest.source.git_dirty ? "dirty" : "clean"
    }`,
    local: manifest.local_dir,
    files: manifest.files
      .map((file) => `${file.name} ${file.size_bytes}B sha256:${file.sha256}`)
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
  const matches = manifests.filter(
    ({ manifest }) =>
      manifest.tag === selector || manifest.artifact_id === selector,
  );
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

function softwareR2Client(deps: SoftwareCommandDeps): SoftwareR2Client {
  if (!deps.r2Client) {
    return loadDefaultSoftwareR2Client();
  }
  return typeof deps.r2Client === "function" ? deps.r2Client() : deps.r2Client;
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
    .option("--limit <n>", "maximum rows to show", "10")
    .action(
      async (componentArg: string, opts: ListOptions, command: Command) => {
        const component = parseSoftwareBuildComponent(componentArg);
        const localStore = resolveSoftwareLocalStore({
          option: opts.localStore,
          env: deps.env ?? process.env,
        });
        const limit = parseLimit(opts.limit);
        const rows = (await listLocalManifests({ localStore, component }))
          .slice(0, limit)
          .map(manifestToListRow);
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
    .argument("[profile-or-channel]", "site profile or release channel")
    .action(() => {
      throw new Error("software deploy is not implemented yet");
    });

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
