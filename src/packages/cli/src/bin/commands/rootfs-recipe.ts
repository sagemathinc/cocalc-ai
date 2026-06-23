import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import type { ExecuteCodeOutput } from "@cocalc/util/types/execute-code";

import type { RootfsConfigExport } from "@cocalc/util/rootfs-images";
import { parse as parseYaml } from "yaml";

type JsonObject = Record<string, any>;

type BuiltinRootfsRecipes = {
  version: 1;
  hash: string;
  files: Record<string, string>;
};

export type RootfsRecipe = {
  version: 1;
  name?: string;
  base?: {
    image?: string;
    image_id?: string;
  };
  builder?: {
    run_quota?: JsonObject;
  };
  steps?: RootfsRecipeStep[];
  verify?: (string | RootfsRecipeCommand)[];
  publish?: RootfsRecipePublish;
};

export type RootfsRecipeStep = {
  name?: string;
  uses?: string;
  run?: string | RootfsRecipeCommand;
  with?: JsonObject;
  timeout?: number;
};

type RootfsRecipeCommand = {
  command: string;
  timeout?: number;
};

type RootfsRecipePublish = {
  label?: string;
  slug?: string;
  description?: string;
  family?: string;
  version?: string;
  channel?: string;
  default_jupyter_kernel?: string;
  visibility?: string;
  tags?: string[];
  theme?: JsonObject;
  content?: JsonObject;
};

type RootfsRecipeModule = {
  id: string;
  version?: number;
  description?: string;
  timeout?: number;
  inputs?: Record<
    string,
    {
      type?: string;
      required?: boolean;
      default?: any;
    }
  >;
  run?: {
    shell?: string;
    script?: string;
    command?: string;
  };
  verify?: {
    shell?: string;
    script?: string;
    command?: string;
  };
  contributes?: {
    metadata?: Partial<RootfsRecipePublish>;
    theme?: JsonObject;
    content?: JsonObject;
  };
};

export type RootfsRecipeRunOptions = {
  browserId?: string;
  configOut?: string;
  detach?: boolean;
  dryRun?: boolean;
  here?: boolean;
  moduleDir?: string;
  project?: string;
  publish?: boolean;
  stepTimeout?: string;
  switchProject?: boolean;
  title?: string;
  verifyOnly?: boolean;
  wait?: boolean;
};

export type RootfsRecipeRunResult = {
  recipe: string;
  recipe_path: string;
  project_id: string;
  created_project: boolean;
  steps: RootfsRecipeStepResult[];
  verify: RootfsRecipeStepResult[];
  config: RootfsConfigExport;
  config_path?: string;
  publish?: unknown;
};

export type RootfsRecipeBuildPlan = {
  recipe: string;
  recipe_path: string;
  module_dir: string;
  base?: RootfsRecipe["base"];
  builder?: RootfsRecipe["builder"];
  config: RootfsConfigExport;
  resolved_recipe: RootfsRecipe;
  script: string;
};

export type RootfsRecipeListResult = {
  module_dir: string;
  examples: {
    name: string;
    path: string;
    label?: string;
    description?: string;
    steps: number;
  }[];
  modules: {
    id: string;
    name: string;
    path: string;
    description?: string;
  }[];
};

type RootfsRecipeStepResult = {
  name: string;
  exit_code: number;
  stdout?: string;
  stderr?: string;
};

type RecipeProjectApiRef = {
  api: any;
};

type RecipeCommandExecutor = (opts: {
  env: Record<string, string>;
  name: string;
  script: string;
  timeout?: number;
}) => Promise<RootfsRecipeStepResult>;

type RootfsRecipeRunnerDeps = {
  resolveProjectFromArgOrContext: (
    ctx: any,
    project?: string,
  ) => Promise<{ project_id: string; title?: string }>;
  resolveProjectProjectApi: (
    ctx: any,
    project?: string,
  ) => Promise<{ project: { project_id: string }; api: any }>;
  waitForLro: (
    ctx: any,
    op_id: string,
    opts: { timeoutMs: number; pollMs: number },
  ) => Promise<{ status: string; timedOut?: boolean; error?: string | null }>;
  serializeLroSummary: (summary: unknown) => unknown;
};

type LoadedModule = {
  dir: string;
  module: RootfsRecipeModule;
  readFile: (path: string) => string;
};

type LoadedRecipe = {
  moduleDir: string;
  recipe: RootfsRecipe;
  recipeDir: string;
  recipePath: string;
};

const DEFAULT_RECIPE_COMMAND_TIMEOUT_SECONDS = 900;
const BUILTIN_RECIPE_MODULE_DIR = "builtin:/rootfs-recipes";
const EMPTY_BUILTIN_ROOTFS_RECIPES: BuiltinRootfsRecipes = {
  version: 1,
  hash: "",
  files: {},
};
const BUILTIN_ROOTFS_RECIPES = loadBuiltinRootfsRecipes();

function loadBuiltinRootfsRecipes(): BuiltinRootfsRecipes {
  try {
    const mod = require("./rootfs-recipes-builtin.generated") as {
      BUILTIN_ROOTFS_RECIPES?: BuiltinRootfsRecipes;
    };
    return mod.BUILTIN_ROOTFS_RECIPES ?? EMPTY_BUILTIN_ROOTFS_RECIPES;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "MODULE_NOT_FOUND") {
      return EMPTY_BUILTIN_ROOTFS_RECIPES;
    }
    throw err;
  }
}

export function loadRootfsRecipe(recipePath: string): RootfsRecipe {
  const resolved = resolve(recipePath);
  let parsed: unknown;
  try {
    parsed = parseRecipeText(resolved, readFileSync(resolved, "utf8"));
  } catch (err) {
    throw new Error(
      `invalid recipe file '${recipePath}': ${err}. Expected .json, .yaml, or .yml.`,
    );
  }
  return normalizeRecipe(parsed, resolved);
}

function loadRootfsRecipePath(recipePath: string): RootfsRecipe {
  const parsed = parseRecipeText(recipePath, readRootfsRecipeText(recipePath));
  return normalizeRecipe(parsed, recipePath);
}

function loadRootfsRecipeSource(
  recipe: string,
  requestedModuleDir?: string,
): LoadedRecipe {
  const candidatePath = resolve(recipe);
  if (existsSync(candidatePath)) {
    const path = resolveRecipePathFromExistingPath(candidatePath);
    const parsed = parseRecipeText(path, readFileSync(path, "utf8"));
    if (isRecipeModule(parsed)) {
      const moduleDir =
        requestedModuleDir != null
          ? resolveRecipeModuleDir(requestedModuleDir, dirname(path))
          : moduleDirFromModuleRecipePath(path);
      return {
        moduleDir,
        recipe: moduleAsRecipe(parsed),
        recipeDir: dirname(path),
        recipePath: path,
      };
    }
    return {
      moduleDir: resolveRecipeModuleDir(requestedModuleDir, dirname(path)),
      recipe: normalizeRecipe(parsed, path),
      recipeDir: dirname(path),
      recipePath: path,
    };
  }

  const moduleDir = resolveRecipeModuleDir(requestedModuleDir, process.cwd());
  const examplePath = resolveBundledExamplePath(recipe, moduleDir);
  if (examplePath) {
    return {
      moduleDir,
      recipe: loadRootfsRecipePath(examplePath),
      recipeDir: dirname(examplePath),
      recipePath: examplePath,
    };
  }

  const moduleId = resolveRecipeModuleId(recipe, moduleDir);
  if (moduleId) {
    const loaded = loadRecipeModule(moduleId, moduleDir);
    return {
      moduleDir,
      recipe: moduleAsRecipe(loaded.module),
      recipeDir: loaded.dir,
      recipePath: join(loaded.dir, "recipe.json"),
    };
  }

  throw new Error(
    `unknown RootFS recipe '${recipe}'. Use a recipe file path, a bundled example name such as 'cocalc-base', or a module name such as 'cocalc/jupyter-python'.`,
  );
}

export function listRootfsRecipes(moduleDir?: string): RootfsRecipeListResult {
  const resolvedModuleDir = resolveRecipeModuleDir(moduleDir, process.cwd());
  return {
    module_dir: resolvedModuleDir,
    examples: listRootfsRecipeExamples(resolvedModuleDir),
    modules: listRootfsRecipeModules(resolvedModuleDir),
  };
}

function listRootfsRecipeExamples(
  moduleDir: string,
): RootfsRecipeListResult["examples"] {
  if (isBuiltinRecipeModuleDir(moduleDir)) {
    return Object.keys(BUILTIN_ROOTFS_RECIPES.files)
      .filter((path) => path.startsWith("examples/"))
      .filter((path) => [".json", ".yaml", ".yml"].includes(extname(path)))
      .map((path) => {
        const fullPath = builtinRecipePath(path);
        const recipe = normalizeRecipe(
          parseRecipeText(fullPath, readRootfsRecipeText(fullPath)),
          fullPath,
        );
        return {
          name: recipe.name ?? basenameWithoutRecipeExtension(path),
          path: fullPath,
          label: recipe.publish?.label,
          description: recipe.publish?.description,
          steps: recipe.steps?.length ?? 0,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const examplesDir = join(moduleDir, "examples");
  if (!existsSync(examplesDir)) return [];
  return readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(examplesDir, entry.name))
    .filter((path) => [".json", ".yaml", ".yml"].includes(extname(path)))
    .map((path) => {
      const recipe = loadRootfsRecipe(path);
      return {
        name: recipe.name ?? basenameWithoutRecipeExtension(path),
        path,
        label: recipe.publish?.label,
        description: recipe.publish?.description,
        steps: recipe.steps?.length ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listRootfsRecipeModules(
  moduleDir: string,
): RootfsRecipeListResult["modules"] {
  if (isBuiltinRecipeModuleDir(moduleDir)) {
    return Object.keys(BUILTIN_ROOTFS_RECIPES.files)
      .filter((path) => /^[^/]+\/[^/]+\/recipe\.json$/.test(path))
      .map((path) => {
        const fullPath = builtinRecipePath(path);
        const parsed = JSON.parse(readRootfsRecipeText(fullPath));
        if (!isRecipeModule(parsed)) {
          throw new Error(`recipe module file '${fullPath}' is invalid`);
        }
        return {
          id: parsed.id,
          name: parsed.id.split("/").at(-1) ?? parsed.id,
          path: fullPath,
          description: parsed.description,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  if (!existsSync(moduleDir)) return [];
  return readdirSync(moduleDir, { withFileTypes: true })
    .filter((namespace) => namespace.isDirectory())
    .flatMap((namespace) => {
      const namespaceDir = join(moduleDir, namespace.name);
      return readdirSync(namespaceDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(namespaceDir, entry.name, "recipe.json"))
        .filter((path) => existsSync(path))
        .map((path) => {
          const parsed = JSON.parse(readFileSync(path, "utf8"));
          if (!isRecipeModule(parsed)) {
            throw new Error(`recipe module file '${path}' is invalid`);
          }
          return {
            id: parsed.id,
            name: parsed.id.split("/").at(-1) ?? parsed.id,
            path,
            description: parsed.description,
          };
        });
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function basenameWithoutRecipeExtension(path: string): string {
  const base = path.split(/[\\/]/).at(-1) ?? path;
  return base.replace(/\.(json|ya?ml)$/i, "");
}

function resolveRecipePathFromExistingPath(path: string): string {
  if (!statSync(path).isDirectory()) return path;
  for (const name of ["recipe.yaml", "recipe.yml", "recipe.json"]) {
    const candidate = join(path, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `recipe directory '${path}' must contain recipe.yaml, recipe.yml, or recipe.json`,
  );
}

function resolveBundledExamplePath(
  recipe: string,
  moduleDir: string,
): string | undefined {
  if (recipe.includes("/") || recipe.includes("\\")) return;
  if (isBuiltinRecipeModuleDir(moduleDir)) {
    const candidates = extname(recipe)
      ? [`examples/${recipe}`]
      : [
          `examples/${recipe}.yaml`,
          `examples/${recipe}.yml`,
          `examples/${recipe}.json`,
        ];
    const match = candidates.find((path) => hasBuiltinRecipeFile(path));
    return match ? builtinRecipePath(match) : undefined;
  }
  const examplesDir = join(moduleDir, "examples");
  const candidates = extname(recipe)
    ? [join(examplesDir, recipe)]
    : [
        join(examplesDir, `${recipe}.yaml`),
        join(examplesDir, `${recipe}.yml`),
        join(examplesDir, `${recipe}.json`),
      ];
  return candidates.find((path) => existsSync(path));
}

function resolveRecipeModuleId(
  recipe: string,
  moduleDir: string,
): string | undefined {
  const candidates: string[] = [];
  if (/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/i.test(recipe)) {
    candidates.push(recipe);
  } else if (/^[a-z0-9][a-z0-9_-]*$/i.test(recipe)) {
    candidates.push(`cocalc/${recipe}`);
  }
  return candidates.find((id) => {
    const path = `${id}/recipe.json`;
    if (isBuiltinRecipeModuleDir(moduleDir)) return hasBuiltinRecipeFile(path);
    return existsSync(join(moduleDir, ...id.split("/"), "recipe.json"));
  });
}

function isRecipeModule(value: unknown): value is RootfsRecipeModule {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as RootfsRecipeModule).id === "string" &&
    ((value as RootfsRecipeModule).run != null ||
      (value as RootfsRecipeModule).verify != null ||
      (value as RootfsRecipeModule).inputs != null)
  );
}

function moduleAsRecipe(module: RootfsRecipeModule): RootfsRecipe {
  return {
    version: 1,
    name: module.id,
    steps: [{ uses: module.id, timeout: module.timeout }],
    verify: [],
  };
}

function moduleDirFromModuleRecipePath(path: string): string {
  return dirname(dirname(dirname(path)));
}

function parseRecipeText(path: string, text: string): unknown {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return JSON.parse(text);
  if (ext === ".yaml" || ext === ".yml") return parseYaml(text);
  throw new Error(`unsupported recipe extension '${ext || "(none)"}'`);
}

export function explainRootfsRecipe(recipePath: string, moduleDir?: string) {
  const loadedRecipe = loadRootfsRecipeSource(recipePath, moduleDir);
  const { recipe } = loadedRecipe;
  const baseModuleDir = loadedRecipe.moduleDir;
  const steps = (recipe.steps ?? []).map((step, index) => {
    if (!step.uses) {
      return {
        index: index + 1,
        name: step.name ?? `step ${index + 1}`,
        kind: "run",
        run: typeof step.run === "string" ? step.run : step.run?.command,
        timeout: step.timeout,
      };
    }
    const loaded = loadRecipeModule(step.uses, baseModuleDir);
    return {
      index: index + 1,
      name: step.name ?? step.uses,
      kind: "uses",
      uses: step.uses,
      module_dir: loaded.dir,
      description: loaded.module.description,
      inputs: applyModuleInputDefaults(loaded.module, step.with ?? {}),
      timeout: step.timeout,
      contributes: loaded.module.contributes ?? {},
    };
  });
  return {
    recipe: recipe.name ?? loadedRecipe.recipePath,
    recipe_path: loadedRecipe.recipePath,
    base: recipe.base ?? null,
    builder: recipe.builder ?? null,
    module_dir: baseModuleDir,
    steps,
    verify: recipe.verify ?? [],
    publish: recipe.publish ?? null,
  };
}

export function renderRootfsRecipeDryRunScript(
  recipePath: string,
  options: Pick<RootfsRecipeRunOptions, "moduleDir" | "stepTimeout"> = {},
): string {
  return resolveRootfsRecipeBuildPlan(recipePath, options).script;
}

export function resolveRootfsRecipeBuildPlan(
  recipePath: string,
  options: Pick<RootfsRecipeRunOptions, "moduleDir" | "stepTimeout"> = {},
): RootfsRecipeBuildPlan {
  const loadedRecipe = loadRootfsRecipeSource(recipePath, options.moduleDir);
  const { recipe } = loadedRecipe;
  const moduleDir = loadedRecipe.moduleDir;
  const defaultCommandTimeout = parseRecipeCommandTimeout(options.stepTimeout);
  const contributionConfig = rootfsRecipeConfigForLoadedRecipe({
    loadedRecipe,
    moduleDir,
  });
  const blocks: string[] = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Generated by: cocalc rootfs recipe run --dry-run",
    `# Recipe: ${recipe.name ?? loadedRecipe.recipePath}`,
    `# Recipe path: ${loadedRecipe.recipePath}`,
    `# Module directory: ${moduleDir}`,
    "#",
    "# This script expands recipe modules and default inputs into the shell",
    "# commands that would run inside a project. Timeout values are shown as",
    "# comments for transparency but are not enforced by this script.",
    "",
  ];

  for (let i = 0; i < (recipe.steps ?? []).length; i += 1) {
    const step = recipe.steps![i];
    blocks.push(
      ...renderDryRunStep({
        defaultCommandTimeout,
        moduleDir,
        recipeDir: loadedRecipe.recipeDir,
        step,
        stepIndex: i + 1,
      }),
      "",
    );
  }

  for (let i = 0; i < (recipe.verify ?? []).length; i += 1) {
    const verify = recipe.verify![i];
    const command = typeof verify === "string" ? verify : verify.command;
    const timeout =
      typeof verify === "string"
        ? defaultCommandTimeout
        : (verify.timeout ?? defaultCommandTimeout);
    blocks.push(
      ...renderShellBlock({
        env: {},
        heading: `Top-level verify ${i + 1}`,
        script: command,
        timeout,
      }),
      "",
    );
  }

  blocks.push(
    "# RootFS publish/config metadata produced by this recipe:",
    "# This here-doc is intentionally inert; remove the leading ':' line if you",
    "# want to write it to a file after adapting this script.",
    ": <<'COCALC_ROOTFS_CONFIG_JSON'",
    JSON.stringify(contributionConfig, null, 2),
    "COCALC_ROOTFS_CONFIG_JSON",
    "",
  );

  return {
    recipe: recipe.name ?? loadedRecipe.recipePath,
    recipe_path: loadedRecipe.recipePath,
    module_dir: moduleDir,
    base: recipe.base,
    builder: recipe.builder,
    config: contributionConfig,
    resolved_recipe: recipe,
    script: blocks.join("\n"),
  };
}

export async function runRootfsRecipe({
  ctx,
  deps,
  options,
  recipePath,
}: {
  ctx: any;
  deps: RootfsRecipeRunnerDeps;
  options: RootfsRecipeRunOptions;
  recipePath: string;
}): Promise<RootfsRecipeRunResult> {
  const loadedRecipe = loadRootfsRecipeSource(recipePath, options.moduleDir);
  const { recipe } = loadedRecipe;
  const moduleDir = loadedRecipe.moduleDir;
  const defaultCommandTimeout = parseRecipeCommandTimeout(options.stepTimeout);
  const recipeTimeoutMs = recipeRunTimeoutMs(
    ctx,
    recipe,
    defaultCommandTimeout,
  );

  return await withRecipeTransportTimeout(ctx, recipeTimeoutMs, async () => {
    if (options.here) {
      return await runRootfsRecipeHere({
        ctx,
        deps,
        defaultCommandTimeout,
        loadedRecipe,
        moduleDir,
        options,
      });
    }
    emitCurrentProjectHint(ctx, options);
    const project = await resolveOrCreateRecipeProject({
      ctx,
      deps,
      options,
      recipe,
    });
    emitRecipeProgress(
      ctx,
      `${project.created ? "created" : "using"} builder project ${project.project_id}`,
    );
    emitRecipeProgress(ctx, "connecting to project host api");
    const resolved = await phase(
      `connect to project host api for ${project.project_id}`,
      async () => await deps.resolveProjectProjectApi(ctx, project.project_id),
    );
    const apiRef: RecipeProjectApiRef = { api: resolved.api };
    const refreshProjectApi = async () => {
      const refreshed = await deps.resolveProjectProjectApi(
        ctx,
        project.project_id,
      );
      await refreshed.api.waitUntilReady?.({ timeout: ctx.timeoutMs });
      apiRef.api = refreshed.api;
    };
    await phase(
      `wait for project host api for ${project.project_id}`,
      async () => await apiRef.api.waitUntilReady?.({ timeout: ctx.timeoutMs }),
    );

    const stepResults: RootfsRecipeStepResult[] = [];
    const contributionConfig = emptyRecipeConfig(recipe);
    if (!options.verifyOnly) {
      for (let i = 0; i < (recipe.steps ?? []).length; i += 1) {
        const step = recipe.steps![i];
        emitRecipeProgress(
          ctx,
          `running step ${i + 1}/${recipe.steps!.length}: ${
            step.name ?? step.uses ?? "run"
          }`,
        );
        const result = await runRecipeStep({
          execCommand: (opts) =>
            execRemoteRecipeCommand({
              apiRef,
              ctx,
              defaultTimeout: defaultCommandTimeout,
              refreshProjectApi,
              ...opts,
            }),
          moduleDir,
          recipeDir: loadedRecipe.recipeDir,
          step,
          stepIndex: i + 1,
        });
        stepResults.push(result);
        if (result.exit_code !== 0) {
          throw new Error(
            `recipe step failed: ${result.name} exit_code=${result.exit_code}\n${result.stderr ?? ""}`,
          );
        }
        mergeRecipeConfig(
          contributionConfig,
          resultContribution(step, moduleDir),
        );
      }
      mergeRecipeConfig(contributionConfig, emptyRecipeConfig(recipe));
    }

    const verifyResults: RootfsRecipeStepResult[] = [];
    for (let i = 0; i < (recipe.verify ?? []).length; i += 1) {
      const verify = recipe.verify![i];
      emitRecipeProgress(
        ctx,
        `running top-level verification ${i + 1}/${recipe.verify!.length}`,
      );
      const result = await execRemoteRecipeCommand({
        env: {},
        apiRef,
        ctx,
        defaultTimeout: defaultCommandTimeout,
        name: `verify ${i + 1}`,
        refreshProjectApi,
        script: typeof verify === "string" ? verify : verify.command,
        timeout: typeof verify === "string" ? undefined : verify.timeout,
      });
      verifyResults.push(result);
      if (result.exit_code !== 0) {
        throw new Error(
          `recipe verification failed: ${result.name} exit_code=${result.exit_code}\n${result.stderr ?? ""}`,
        );
      }
    }

    let publishResult: unknown;
    if (options.publish && !options.verifyOnly) {
      emitRecipeProgress(ctx, "publishing builder project RootFS");
      const payload = recipeConfigToCatalogPayload(contributionConfig);
      const op = await ctx.hub.system.publishProjectRootfsImage({
        project_id: project.project_id,
        browser_id: `${options.browserId ?? ""}`.trim() || undefined,
        ...payload,
        switch_project: options.switchProject ? true : undefined,
      });
      if (options.wait) {
        const waited = await deps.waitForLro(ctx, op.op_id, {
          timeoutMs: ctx.timeoutMs,
          pollMs: ctx.pollMs,
        });
        if (waited.timedOut) {
          throw new Error(
            `rootfs recipe publish timed out (op=${op.op_id}, last_status=${waited.status})`,
          );
        }
        const summary = await ctx.hub.lro.get({ op_id: op.op_id });
        if (summary?.status && summary.status !== "succeeded") {
          throw new Error(
            `rootfs recipe publish failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
          );
        }
        publishResult = summary ? deps.serializeLroSummary(summary) : waited;
      } else {
        publishResult = {
          op_id: op.op_id,
          scope_type: op.scope_type,
          scope_id: op.scope_id,
          stream_name: op.stream_name,
          status: "queued",
        };
      }
    }

    return {
      recipe: recipe.name ?? loadedRecipe.recipePath,
      recipe_path: loadedRecipe.recipePath,
      project_id: project.project_id,
      created_project: project.created,
      steps: stepResults,
      verify: verifyResults,
      config: contributionConfig,
      publish: publishResult,
    };
  });
}

async function runRootfsRecipeHere({
  ctx,
  deps,
  defaultCommandTimeout,
  loadedRecipe,
  moduleDir,
  options,
}: {
  ctx: any;
  deps: RootfsRecipeRunnerDeps;
  defaultCommandTimeout: number;
  loadedRecipe: LoadedRecipe;
  moduleDir: string;
  options: RootfsRecipeRunOptions;
}): Promise<RootfsRecipeRunResult> {
  if (options.project) {
    throw new Error("--here cannot be combined with --project");
  }
  const project_id = `${process.env.COCALC_PROJECT_ID ?? ""}`.trim();
  if (!project_id) {
    throw new Error(
      "--here requires running inside a CoCalc project with COCALC_PROJECT_ID set",
    );
  }
  const { recipe } = loadedRecipe;
  emitRecipeProgress(
    ctx,
    `using current project ${project_id}; recipe commands run as local subprocesses`,
  );

  const stepResults: RootfsRecipeStepResult[] = [];
  const contributionConfig = emptyRecipeConfig(recipe);
  if (!options.verifyOnly) {
    for (let i = 0; i < (recipe.steps ?? []).length; i += 1) {
      const step = recipe.steps![i];
      emitRecipeProgress(
        ctx,
        `running local step ${i + 1}/${recipe.steps!.length}: ${
          step.name ?? step.uses ?? "run"
        }`,
      );
      const result = await runRecipeStep({
        execCommand: (opts) =>
          execLocalRecipeCommand({
            ctx,
            defaultTimeout: defaultCommandTimeout,
            ...opts,
          }),
        moduleDir,
        recipeDir: loadedRecipe.recipeDir,
        step,
        stepIndex: i + 1,
      });
      stepResults.push(result);
      if (result.exit_code !== 0) {
        throw new Error(
          `recipe step failed: ${result.name} exit_code=${result.exit_code}\n${result.stderr ?? ""}`,
        );
      }
      mergeRecipeConfig(
        contributionConfig,
        resultContribution(step, moduleDir),
      );
    }
    mergeRecipeConfig(contributionConfig, emptyRecipeConfig(recipe));
  }

  const verifyResults: RootfsRecipeStepResult[] = [];
  for (let i = 0; i < (recipe.verify ?? []).length; i += 1) {
    const verify = recipe.verify![i];
    emitRecipeProgress(
      ctx,
      `running local top-level verification ${i + 1}/${recipe.verify!.length}`,
    );
    const result = await execLocalRecipeCommand({
      ctx,
      defaultTimeout: defaultCommandTimeout,
      env: {},
      name: `verify ${i + 1}`,
      script: typeof verify === "string" ? verify : verify.command,
      timeout: typeof verify === "string" ? undefined : verify.timeout,
    });
    verifyResults.push(result);
    if (result.exit_code !== 0) {
      throw new Error(
        `recipe verification failed: ${result.name} exit_code=${result.exit_code}\n${result.stderr ?? ""}`,
      );
    }
  }

  const configPath =
    options.configOut != null
      ? resolve(options.configOut)
      : writeDefaultLocalRecipeConfig(loadedRecipe, contributionConfig);
  if (options.configOut == null) {
    emitRecipeProgress(ctx, `wrote RootFS config JSON to ${configPath}`);
  }

  let publishResult: unknown;
  if (options.publish && !options.verifyOnly) {
    emitRecipeProgress(ctx, "publishing current project RootFS");
    const payload = recipeConfigToCatalogPayload(contributionConfig);
    const op = await ctx.hub.system.publishProjectRootfsImage({
      project_id,
      browser_id: `${options.browserId ?? ""}`.trim() || undefined,
      ...payload,
      switch_project: options.switchProject ? true : undefined,
    });
    if (options.wait) {
      const waited = await deps.waitForLro(ctx, op.op_id, {
        timeoutMs: ctx.timeoutMs,
        pollMs: ctx.pollMs,
      });
      if (waited.timedOut) {
        throw new Error(
          `rootfs recipe publish timed out (op=${op.op_id}, last_status=${waited.status})`,
        );
      }
      const summary = await ctx.hub.lro.get({ op_id: op.op_id });
      if (summary?.status && summary.status !== "succeeded") {
        throw new Error(
          `rootfs recipe publish failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
        );
      }
      publishResult = summary ? deps.serializeLroSummary(summary) : waited;
    } else {
      publishResult = {
        op_id: op.op_id,
        scope_type: op.scope_type,
        scope_id: op.scope_id,
        stream_name: op.stream_name,
        status: "queued",
      };
    }
  }

  return {
    recipe: recipe.name ?? loadedRecipe.recipePath,
    recipe_path: loadedRecipe.recipePath,
    project_id,
    created_project: false,
    steps: stepResults,
    verify: verifyResults,
    config: contributionConfig,
    config_path: configPath,
    publish: publishResult,
  };
}

async function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(`${name} failed: ${errorMessage(err)}`);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return `${err}`;
}

function parseRecipeCommandTimeout(value?: string): number {
  if (value == null || `${value}`.trim() === "") {
    return DEFAULT_RECIPE_COMMAND_TIMEOUT_SECONDS;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`invalid recipe step timeout '${value}'`);
  }
  return seconds;
}

function recipeRunTimeoutMs(
  ctx: any,
  recipe: RootfsRecipe,
  defaultCommandTimeout: number,
): number {
  const seconds = [
    ...(recipe.steps ?? []).map(
      (step) => step.timeout ?? defaultCommandTimeout,
    ),
    ...(recipe.verify ?? []).map((verify) =>
      typeof verify === "string"
        ? defaultCommandTimeout
        : (verify.timeout ?? defaultCommandTimeout),
    ),
  ].filter((value): value is number => Number.isFinite(value));
  const maxCommandMs = seconds.length
    ? Math.max(...seconds.map((value) => value * 1000 + 5_000))
    : 0;
  return Math.max(Number(ctx.timeoutMs ?? 0), maxCommandMs, 30_000);
}

async function withRecipeTransportTimeout<T>(
  ctx: any,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const prevTimeoutMs = ctx.timeoutMs;
  const prevRpcTimeoutMs = ctx.rpcTimeoutMs;
  ctx.timeoutMs = Math.max(Number(prevTimeoutMs ?? 0), timeoutMs);
  ctx.rpcTimeoutMs = Math.max(Number(prevRpcTimeoutMs ?? 0), timeoutMs);
  try {
    return await fn();
  } finally {
    ctx.timeoutMs = prevTimeoutMs;
    ctx.rpcTimeoutMs = prevRpcTimeoutMs;
  }
}

function emitRecipeProgress(ctx: any, message: string): void {
  if (
    ctx.globals?.quiet ||
    ctx.globals?.json ||
    ctx.globals?.output === "json"
  ) {
    return;
  }
  console.error(`[rootfs recipe] ${message}`);
}

async function resolveOrCreateRecipeProject({
  ctx,
  deps,
  options,
  recipe,
}: {
  ctx: any;
  deps: RootfsRecipeRunnerDeps;
  options: RootfsRecipeRunOptions;
  recipe: RootfsRecipe;
}): Promise<{ project_id: string; created: boolean }> {
  if (options.project) {
    const project = await deps.resolveProjectFromArgOrContext(
      ctx,
      options.project,
    );
    await startProject(ctx, deps, project.project_id);
    return { project_id: project.project_id, created: false };
  }
  const projectId = await ctx.hub.projects.createProject({
    title: options.title ?? `RootFS build: ${recipe.name ?? "builder"}`,
    rootfs_image: recipe.base?.image,
    rootfs_image_id: recipe.base?.image_id,
    run_quota: recipe.builder?.run_quota,
    start: false,
  });
  await startProject(ctx, deps, projectId);
  return { project_id: projectId, created: true };
}

async function startProject(
  ctx: any,
  deps: RootfsRecipeRunnerDeps,
  project_id: string,
): Promise<void> {
  const op = await ctx.hub.projects.start({ project_id, wait: false });
  const waited = await deps.waitForLro(ctx, op.op_id, {
    timeoutMs: ctx.timeoutMs,
    pollMs: ctx.pollMs,
  });
  if (waited.timedOut) {
    throw new Error(
      `timeout waiting for recipe builder project start op ${op.op_id}; last_status=${waited.status}`,
    );
  }
  if (waited.status !== "succeeded" && waited.status !== "done") {
    throw new Error(
      `recipe builder project start failed: status=${waited.status} error=${waited.error ?? "unknown"}`,
    );
  }
}

async function runRecipeStep({
  execCommand,
  moduleDir,
  recipeDir,
  step,
  stepIndex,
}: {
  execCommand: RecipeCommandExecutor;
  moduleDir: string;
  recipeDir: string;
  step: RootfsRecipeStep;
  stepIndex: number;
}): Promise<RootfsRecipeStepResult> {
  if (!step.uses) {
    const run = step.run;
    if (!run) {
      throw new Error(`recipe step ${stepIndex} must specify uses or run`);
    }
    return await execCommand({
      env: {},
      name: step.name ?? `step ${stepIndex}`,
      script: typeof run === "string" ? run : run.command,
      timeout:
        step.timeout ?? (typeof run === "string" ? undefined : run.timeout),
    });
  }

  const loaded = loadRecipeModule(step.uses, moduleDir);
  const inputs = applyModuleInputDefaults(loaded.module, {
    ...(step.with ?? {}),
    recipe_dir: recipeDir,
  });
  const run = loaded.module.run;
  if (!run?.script && !run?.command) {
    throw new Error(`recipe module ${step.uses} has no run script or command`);
  }
  const script = run.script ? loaded.readFile(run.script) : run.command!;
  const result = await execCommand({
    env: recipeEnv(inputs, step.uses),
    name: step.name ?? step.uses,
    script,
    timeout: step.timeout,
  });
  if (result.exit_code !== 0) return result;
  const verify = loaded.module.verify;
  if (verify?.script || verify?.command) {
    const verifyScript = verify.script
      ? loaded.readFile(verify.script)
      : verify.command!;
    const verifyResult = await execCommand({
      env: recipeEnv(inputs, step.uses),
      name: `${step.name ?? step.uses} verify`,
      script: verifyScript,
      timeout: step.timeout,
    });
    if (verifyResult.exit_code !== 0) return verifyResult;
  }
  return result;
}

function renderDryRunStep({
  defaultCommandTimeout,
  moduleDir,
  recipeDir,
  step,
  stepIndex,
}: {
  defaultCommandTimeout: number;
  moduleDir: string;
  recipeDir: string;
  step: RootfsRecipeStep;
  stepIndex: number;
}): string[] {
  if (!step.uses) {
    const run = step.run;
    if (!run) {
      throw new Error(`recipe step ${stepIndex} must specify uses or run`);
    }
    return renderShellBlock({
      env: {},
      heading: `Step ${stepIndex}: ${step.name ?? `step ${stepIndex}`}`,
      script: typeof run === "string" ? run : run.command,
      timeout:
        step.timeout ??
        (typeof run === "string" ? defaultCommandTimeout : run.timeout) ??
        defaultCommandTimeout,
    });
  }

  const loaded = loadRecipeModule(step.uses, moduleDir);
  const inputs = applyModuleInputDefaults(loaded.module, {
    ...(step.with ?? {}),
    recipe_dir: recipeDir,
  });
  const run = loaded.module.run;
  if (!run?.script && !run?.command) {
    throw new Error(`recipe module ${step.uses} has no run script or command`);
  }
  const timeout = step.timeout ?? defaultCommandTimeout;
  const rendered = renderShellBlock({
    env: recipeEnv(inputs, step.uses),
    heading: `Step ${stepIndex}: ${step.name ?? step.uses}`,
    notes: [
      `Module: ${step.uses}`,
      `Module path: ${loaded.dir}`,
      ...(loaded.module.description
        ? [`Description: ${loaded.module.description}`]
        : []),
    ],
    script: run.script ? loaded.readFile(run.script) : run.command!,
    timeout,
  });

  const verify = loaded.module.verify;
  if (verify?.script || verify?.command) {
    rendered.push(
      "",
      ...renderShellBlock({
        env: recipeEnv(inputs, step.uses),
        heading: `Step ${stepIndex} verify: ${step.name ?? step.uses}`,
        notes: [`Module: ${step.uses}`],
        script: verify.script
          ? loaded.readFile(verify.script)
          : verify.command!,
        timeout,
      }),
    );
  }
  return rendered;
}

function renderShellBlock({
  env,
  heading,
  notes = [],
  script,
  timeout,
}: {
  env: Record<string, string>;
  heading: string;
  notes?: string[];
  script: string;
  timeout: number;
}): string[] {
  const envNames = Object.keys(env).sort();
  const delimiter = heredocDelimiter(script, "COCALC_ROOTFS_STEP");
  const lines = [
    `# ${heading}`,
    ...notes.map((note) => `# ${note}`),
    `# Timeout from recipe metadata: ${timeout}s`,
    "(",
    "set -euo pipefail",
  ];
  for (const name of envNames) {
    lines.push(`${name}=${shellQuote(env[name] ?? "")}`);
  }
  if (envNames.length > 0) {
    lines.push(`export ${envNames.join(" ")}`);
  }
  lines.push(`bash <<'${delimiter}'`, script.trimEnd(), delimiter, ")");
  return lines;
}

async function execRemoteRecipeCommand({
  apiRef,
  ctx,
  defaultTimeout,
  env,
  name,
  refreshProjectApi,
  script,
  timeout,
}: {
  apiRef: RecipeProjectApiRef;
  ctx: any;
  defaultTimeout: number;
  env: Record<string, string>;
  name: string;
  refreshProjectApi: () => Promise<void>;
  script: string;
  timeout?: number;
}): Promise<RootfsRecipeStepResult> {
  const commandTimeout = timeout ?? defaultTimeout;
  const started = Date.now();
  const initial = (await apiRef.api.system.exec({
    bash: true,
    command: script,
    env,
    err_on_exit: false,
    max_output: 200_000,
    timeout: commandTimeout,
    async_call: true,
  })) as ExecuteCodeOutput;
  if (initial.type !== "async") {
    emitRecipeOutput(ctx, name, initial, { stdout: 0, stderr: 0 });
    return {
      name,
      exit_code: initial.exit_code,
      stdout: initial.stdout,
      stderr: initial.stderr,
    };
  }

  emitRecipeProgress(
    ctx,
    `${name}: started job ${initial.job_id} (timeout ${commandTimeout}s)`,
  );
  const offsets = { stdout: 0, stderr: 0 };
  let last: ExecuteCodeOutput = initial;
  let reconnectAttempts = 0;
  emitRecipeOutput(ctx, name, last, offsets);
  while (Date.now() - started <= commandTimeout * 1000 + 5_000) {
    await sleep(Math.max(250, Number(ctx.pollMs ?? 1000)));
    try {
      last = (await apiRef.api.system.exec({
        async_get: initial.job_id,
      })) as ExecuteCodeOutput;
      reconnectAttempts = 0;
    } catch (err) {
      if (!isRetryableProjectApiError(err)) {
        throw err;
      }
      reconnectAttempts += 1;
      emitRecipeProgress(
        ctx,
        `${name}: project api disconnected while polling job ${initial.job_id}; reconnecting (${reconnectAttempts})`,
      );
      await refreshProjectApi();
      continue;
    }
    emitRecipeOutput(ctx, name, last, offsets);
    if (last.type !== "async" || isTerminalAsyncStatus(last.status)) {
      return {
        name,
        exit_code: last.exit_code,
        stdout: last.stdout,
        stderr: last.stderr,
      };
    }
  }
  throw new Error(
    `${name}: timeout waiting for async exec job ${initial.job_id}; last_status=${
      last.type === "async" ? last.status : "completed"
    }`,
  );
}

async function execLocalRecipeCommand({
  ctx,
  defaultTimeout,
  env,
  name,
  script,
  timeout,
}: {
  ctx: any;
  defaultTimeout: number;
  env: Record<string, string>;
  name: string;
  script: string;
  timeout?: number;
}): Promise<RootfsRecipeStepResult> {
  const commandTimeout = timeout ?? defaultTimeout;
  emitRecipeProgress(
    ctx,
    `${name}: started local subprocess (timeout ${commandTimeout}s)`,
  );
  return await new Promise<RootfsRecipeStepResult>((resolve, reject) => {
    const child = spawn("bash", ["-c", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let killedForTimeout = false;
    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!finished) {
          child.kill("SIGKILL");
        }
      }, 5_000).unref?.();
    }, commandTimeout * 1000);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = appendCapped(stdout, text);
      emitRecipeTextOutput(ctx, name, text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = appendCapped(stderr, text);
      emitRecipeTextOutput(ctx, name, text);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finished = true;
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      finished = true;
      if (killedForTimeout) {
        resolve({
          name,
          exit_code: 124,
          stdout,
          stderr: appendCapped(
            stderr,
            `\n${name}: timed out after ${commandTimeout}s${
              signal ? `; signal=${signal}` : ""
            }\n`,
          ),
        });
        return;
      }
      resolve({
        name,
        exit_code: code ?? (signal ? 128 : 1),
        stdout,
        stderr,
      });
    });
  });
}

function emitRecipeTextOutput(ctx: any, name: string, text: string): void {
  if (
    ctx.globals?.quiet ||
    ctx.globals?.json ||
    ctx.globals?.output === "json"
  ) {
    return;
  }
  emitPrefixedLines(name, text);
}

function appendCapped(current: string, next: string): string {
  const max = 200_000;
  const joined = current + next;
  if (joined.length <= max) return joined;
  return joined.slice(joined.length - max);
}

function emitCurrentProjectHint(
  ctx: any,
  options: RootfsRecipeRunOptions,
): void {
  if (options.project || options.here) return;
  const projectId = `${process.env.COCALC_PROJECT_ID ?? ""}`.trim();
  if (!projectId) return;
  emitRecipeProgress(
    ctx,
    `detected current project ${projectId}; creating a clean builder project. Use --here to run this recipe in the current project.`,
  );
}

function writeDefaultLocalRecipeConfig(
  loadedRecipe: LoadedRecipe,
  config: RootfsConfigExport,
): string {
  const home = process.env.HOME || process.cwd();
  const dir = join(home, ".cocalc", "rootfs-recipes");
  mkdirSync(dir, { recursive: true });
  const name = safeRecipeFilenamePart(
    loadedRecipe.recipe.name ??
      basenameWithoutRecipeExtension(loadedRecipe.recipePath),
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${name}-${stamp}.rootfs-config.json`);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

function safeRecipeFilenamePart(value: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "rootfs-recipe";
}

function isRetryableProjectApiError(err: unknown): boolean {
  const message = errorMessage(err);
  return /socket has been disconnected|socket is disconnected|connection closed|once: .* not emitted before "closed"|timeout of \d+ms waiting for "info"/i.test(
    message,
  );
}

function isTerminalAsyncStatus(status?: string): boolean {
  return status === "completed" || status === "error" || status === "killed";
}

function emitRecipeOutput(
  ctx: any,
  name: string,
  output: Pick<ExecuteCodeOutput, "stdout" | "stderr">,
  offsets: { stdout: number; stderr: number },
): void {
  if (
    ctx.globals?.quiet ||
    ctx.globals?.json ||
    ctx.globals?.output === "json"
  ) {
    return;
  }
  const stdout = output.stdout ?? "";
  if (stdout.length > offsets.stdout) {
    emitPrefixedLines(name, stdout.slice(offsets.stdout));
    offsets.stdout = stdout.length;
  }
  const stderr = output.stderr ?? "";
  if (stderr.length > offsets.stderr) {
    emitPrefixedLines(name, stderr.slice(offsets.stderr));
    offsets.stderr = stderr.length;
  }
}

function emitPrefixedLines(name: string, text: string): void {
  const write = process.stderr.write.bind(process.stderr);
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    write(`[${name}] ${line}\n`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function heredocDelimiter(script: string, prefix: string): string {
  let delimiter = prefix;
  let i = 1;
  while (script.split(/\r?\n/).includes(delimiter)) {
    i += 1;
    delimiter = `${prefix}_${i}`;
  }
  return delimiter;
}

function recipeEnv(
  inputs: JsonObject,
  moduleId: string,
): Record<string, string> {
  const env: Record<string, string> = {
    COCALC_RECIPE_INPUT_JSON: JSON.stringify(inputs),
    COCALC_RECIPE_MODULE: moduleId,
  };
  for (const [key, value] of Object.entries(inputs)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      env[key.toUpperCase()] = Array.isArray(value)
        ? value.join(" ")
        : value == null
          ? ""
          : `${value}`;
    }
  }
  return env;
}

function resolveRecipeModuleDir(
  requested: string | undefined,
  _recipeDir: string,
): string {
  if (requested) return resolve(requested);
  const envDir = `${process.env.COCALC_ROOTFS_RECIPE_MODULES ?? ""}`.trim();
  if (envDir) return resolve(envDir);
  return BUILTIN_RECIPE_MODULE_DIR;
}

function loadRecipeModule(id: string, moduleDir: string): LoadedModule {
  if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new Error(`invalid recipe module id '${id}'`);
  }
  if (isBuiltinRecipeModuleDir(moduleDir)) {
    const path = `${id}/recipe.json`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readBuiltinRecipeFile(path));
    } catch (err) {
      throw new Error(
        `failed to load built-in recipe module '${id}' from ${builtinRecipePath(
          path,
        )}: ${err}`,
      );
    }
    const module = validateLoadedRecipeModule(
      parsed,
      id,
      builtinRecipePath(path),
    );
    return {
      dir: builtinRecipePath(id),
      module,
      readFile: (relativePath) =>
        readBuiltinRecipeFile(`${id}/${relativePath}`),
    };
  }
  const dir = join(moduleDir, ...id.split("/"));
  const path = join(dir, "recipe.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `failed to load recipe module '${id}' from ${path}: ${err}`,
    );
  }
  return {
    dir,
    module: validateLoadedRecipeModule(parsed, id, path),
    readFile: (relativePath) => readFileSync(join(dir, relativePath), "utf8"),
  };
}

function validateLoadedRecipeModule(
  parsed: unknown,
  id: string,
  path: string,
): RootfsRecipeModule {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`recipe module '${id}' must be a JSON object`);
  }
  const module = parsed as RootfsRecipeModule;
  if (module.id !== id) {
    throw new Error(
      `recipe module ${path} has id '${module.id}', expected '${id}'`,
    );
  }
  return module;
}

function isBuiltinRecipeModuleDir(moduleDir: string): boolean {
  return moduleDir === BUILTIN_RECIPE_MODULE_DIR;
}

function builtinRecipePath(relativePath: string): string {
  return `${BUILTIN_RECIPE_MODULE_DIR}/${normalizeBuiltinRecipePath(relativePath)}`;
}

function isBuiltinRecipePath(path: string): boolean {
  return path.startsWith(`${BUILTIN_RECIPE_MODULE_DIR}/`);
}

function normalizeBuiltinRecipePath(path: string): string {
  return path.replace(/^builtin:\/rootfs-recipes\//, "").replace(/^\/+/, "");
}

function hasBuiltinRecipeFile(path: string): boolean {
  return BUILTIN_ROOTFS_RECIPES.files[normalizeBuiltinRecipePath(path)] != null;
}

function readBuiltinRecipeFile(path: string): string {
  const normalized = normalizeBuiltinRecipePath(path);
  const text = BUILTIN_ROOTFS_RECIPES.files[normalized];
  if (text == null) {
    throw new Error(`built-in RootFS recipe file '${normalized}' not found`);
  }
  return text;
}

function readRootfsRecipeText(path: string): string {
  if (isBuiltinRecipePath(path)) return readBuiltinRecipeFile(path);
  return readFileSync(path, "utf8");
}

function applyModuleInputDefaults(
  module: RootfsRecipeModule,
  input: JsonObject,
): JsonObject {
  const result: JsonObject = { ...input };
  for (const [name, spec] of Object.entries(module.inputs ?? {})) {
    if (result[name] == null && "default" in spec) {
      result[name] = spec.default;
    }
    if (spec.required && result[name] == null) {
      throw new Error(
        `recipe module ${module.id} missing required input '${name}'`,
      );
    }
  }
  return result;
}

function normalizeRecipe(value: unknown, path: string): RootfsRecipe {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`recipe '${path}' must be a JSON object`);
  }
  const recipe = value as RootfsRecipe;
  if (recipe.version !== 1) {
    throw new Error(`recipe '${path}' must have version 1`);
  }
  if (recipe.steps != null && !Array.isArray(recipe.steps)) {
    throw new Error(`recipe '${path}' steps must be an array`);
  }
  if (recipe.verify != null && !Array.isArray(recipe.verify)) {
    throw new Error(`recipe '${path}' verify must be an array`);
  }
  return recipe;
}

function emptyRecipeConfig(recipe: RootfsRecipe): RootfsConfigExport {
  const publish = recipe.publish ?? {};
  return {
    kind: "cocalc-rootfs-config",
    version: 1,
    exported_at: new Date().toISOString(),
    metadata: {
      label: publish.label ?? recipe.name ?? "RootFS recipe image",
      slug: publish.slug,
      description: publish.description,
      family: publish.family,
      version: publish.version,
      channel: publish.channel,
      visibility: publish.visibility as any,
      default_jupyter_kernel: publish.default_jupyter_kernel,
      tags: publish.tags,
    },
    theme: publish.theme as any,
    content: publish.content as any,
  };
}

function rootfsRecipeConfigForLoadedRecipe({
  loadedRecipe,
  moduleDir,
}: {
  loadedRecipe: LoadedRecipe;
  moduleDir: string;
}): RootfsConfigExport {
  const contributionConfig = emptyRecipeConfig(loadedRecipe.recipe);
  for (const step of loadedRecipe.recipe.steps ?? []) {
    mergeRecipeConfig(contributionConfig, resultContribution(step, moduleDir));
  }
  mergeRecipeConfig(contributionConfig, emptyRecipeConfig(loadedRecipe.recipe));
  return contributionConfig;
}

function resultContribution(
  step: RootfsRecipeStep,
  moduleDir: string,
): RootfsConfigExport {
  if (!step.uses) return emptyContributionConfig();
  const module = loadRecipeModule(step.uses, moduleDir).module;
  return {
    kind: "cocalc-rootfs-config",
    version: 1,
    exported_at: new Date().toISOString(),
    metadata: module.contributes?.metadata as any,
    theme: module.contributes?.theme as any,
    content: module.contributes?.content as any,
  };
}

function emptyContributionConfig(): RootfsConfigExport {
  return {
    kind: "cocalc-rootfs-config",
    version: 1,
    exported_at: new Date().toISOString(),
  };
}

function mergeRecipeConfig(
  target: RootfsConfigExport,
  source: RootfsConfigExport,
): void {
  target.metadata = {
    ...(target.metadata ?? {}),
    ...(source.metadata ?? {}),
    tags: mergeTags(target.metadata?.tags, source.metadata?.tags),
  };
  target.theme = { ...(target.theme ?? {}), ...(source.theme ?? {}) };
  const sourceActions = source.content?.actions ?? [];
  if (source.content || sourceActions.length) {
    target.content = {
      version: 1,
      ...(target.content ?? {}),
      ...(source.content ?? {}),
      actions: [...(target.content?.actions ?? []), ...sourceActions],
    };
  }
}

function mergeTags(a?: string[], b?: string[]): string[] | undefined {
  const tags = Array.from(
    new Set([...(a ?? []), ...(b ?? [])].filter(Boolean)),
  );
  return tags.length ? tags : undefined;
}

function recipeConfigToCatalogPayload(config: RootfsConfigExport) {
  const label = config.metadata?.label?.trim();
  if (!label) {
    throw new Error("recipe publish metadata must include a label");
  }
  const payload = {
    label,
    slug: config.metadata?.slug,
    description: config.metadata?.description,
    family: config.metadata?.family,
    version: config.metadata?.version,
    channel: config.metadata?.channel,
    visibility: config.metadata?.visibility,
    tags: config.metadata?.tags,
    theme: config.theme,
    content: config.content,
    content_warnings: [],
  };
  if (config.metadata?.default_jupyter_kernel != null) {
    return {
      ...payload,
      default_jupyter_kernel: config.metadata.default_jupyter_kernel,
    };
  }
  return payload;
}
