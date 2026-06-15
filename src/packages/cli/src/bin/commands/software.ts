import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
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
import type {
  SoftwareArtifactManifest,
  SoftwareBuildComponent,
  SoftwareGitMetadata,
} from "../core/software/types";

export type SoftwareCommandDeps = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  gitMetadata?: (cwd: string) => SoftwareGitMetadata;
};

type BuildOptions = {
  localStore?: string;
  fromFile?: string;
  artifactName?: string;
};

type ListOptions = {
  localStore?: string;
  limit?: string;
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
    Pick<SoftwareCommandDeps, "cwd" | "gitMetadata">;
}): Promise<SoftwareArtifactManifest & { local_dir: string }> {
  if (!opts.fromFile) {
    throw new Error(
      "software build component wrappers are not wired yet; use --from-file <path> to create a local artifact manifest from an existing file",
    );
  }
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
  const dir = artifactDir({ localStore, component, artifactId });
  const filesDir = join(dir, "files");
  const artifactFile = await copyArtifactFile({
    source: opts.fromFile,
    destinationFilesDir: filesDir,
    name: opts.artifactName,
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
      command: `cocalc software build ${component}${
        tagArg ? ` ${tagArg}` : ""
      } --from-file ${opts.fromFile}`,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    },
    files: [artifactFile],
    local_dir: dir,
  };
  await writeLocalManifest({ localStore, manifest });
  return manifest;
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

export function registerSoftwareCommand(
  program: Command,
  deps: SoftwareCommandDeps = {},
): Command {
  const software = program
    .command("software")
    .description("high-level CoCalc software artifact lifecycle");

  software
    .command("build")
    .description("build or record a local immutable software artifact")
    .argument("<component>", "software component")
    .argument("[tag]", "optional human tag; generated if omitted")
    .option("--local-store <path>", "local artifact store")
    .option(
      "--from-file <path>",
      "record an existing artifact file in the local software store",
    )
    .option("--artifact-name <name>", "override stored artifact file name")
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
    .argument("<component>", "software component")
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
    .argument("<component>", "software component")
    .argument("<tag-or-id>", "artifact tag or id")
    .action(() => {
      throw new Error("software push is not implemented yet");
    });

  software
    .command("deploy")
    .description("deploy or promote a software artifact")
    .argument("<component>", "software component")
    .argument("<tag-or-id>", "artifact tag or id")
    .argument("[profile-or-channel]", "site profile or release channel")
    .action(() => {
      throw new Error("software deploy is not implemented yet");
    });

  software
    .command("smoke")
    .description("run a software smoke test")
    .argument("<component>", "software component")
    .argument("[profile-or-channel]", "site profile or release channel")
    .action(() => {
      throw new Error("software smoke is not implemented yet");
    });

  return software;
}
