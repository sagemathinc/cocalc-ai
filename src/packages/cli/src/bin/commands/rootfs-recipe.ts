import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ExecuteCodeOutput } from "@cocalc/util/types/execute-code";

import type { RootfsConfigExport } from "@cocalc/util/rootfs-images";

type JsonObject = Record<string, any>;

export type RootfsRecipe = {
  version: 1;
  name?: string;
  base?: {
    image?: string;
    image_id?: string;
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
  visibility?: string;
  tags?: string[];
  theme?: JsonObject;
  content?: JsonObject;
};

type RootfsRecipeModule = {
  id: string;
  version?: number;
  description?: string;
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
  moduleDir?: string;
  project?: string;
  publish?: boolean;
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
  publish?: unknown;
};

type RootfsRecipeStepResult = {
  name: string;
  exit_code: number;
  stdout?: string;
  stderr?: string;
};

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
};

export function loadRootfsRecipe(recipePath: string): RootfsRecipe {
  const resolved = resolve(recipePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (err) {
    throw new Error(
      `invalid recipe file '${recipePath}': ${err}. Only JSON recipes are supported in this MVP.`,
    );
  }
  return normalizeRecipe(parsed, resolved);
}

export function explainRootfsRecipe(recipePath: string, moduleDir?: string) {
  const resolved = resolve(recipePath);
  const recipe = loadRootfsRecipe(resolved);
  const baseModuleDir = resolveRecipeModuleDir(moduleDir, dirname(resolved));
  const steps = (recipe.steps ?? []).map((step, index) => {
    if (!step.uses) {
      return {
        index: index + 1,
        name: step.name ?? `step ${index + 1}`,
        kind: "run",
        run: typeof step.run === "string" ? step.run : step.run?.command,
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
      contributes: loaded.module.contributes ?? {},
    };
  });
  return {
    recipe: recipe.name ?? resolved,
    recipe_path: resolved,
    base: recipe.base ?? null,
    module_dir: baseModuleDir,
    steps,
    verify: recipe.verify ?? [],
    publish: recipe.publish ?? null,
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
  const resolvedRecipePath = resolve(recipePath);
  const recipe = loadRootfsRecipe(resolvedRecipePath);
  const moduleDir = resolveRecipeModuleDir(
    options.moduleDir,
    dirname(resolvedRecipePath),
  );
  const project = await resolveOrCreateRecipeProject({
    ctx,
    deps,
    options,
    recipe,
  });
  const resolved = await deps.resolveProjectProjectApi(ctx, project.project_id);
  await resolved.api.waitUntilReady?.({ timeout: ctx.timeoutMs });

  const stepResults: RootfsRecipeStepResult[] = [];
  const contributionConfig = emptyRecipeConfig(recipe);
  if (!options.verifyOnly) {
    for (let i = 0; i < (recipe.steps ?? []).length; i += 1) {
      const step = recipe.steps![i];
      const result = await runRecipeStep({
        api: resolved.api,
        moduleDir,
        recipeDir: dirname(resolvedRecipePath),
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
  }

  const verifyResults: RootfsRecipeStepResult[] = [];
  for (let i = 0; i < (recipe.verify ?? []).length; i += 1) {
    const verify = recipe.verify![i];
    const result = await execRecipeCommand({
      api: resolved.api,
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

  let publishResult: unknown;
  if (options.publish && !options.verifyOnly) {
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
    recipe: recipe.name ?? resolvedRecipePath,
    recipe_path: resolvedRecipePath,
    project_id: project.project_id,
    created_project: project.created,
    steps: stepResults,
    verify: verifyResults,
    config: contributionConfig,
    publish: publishResult,
  };
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
    title: options.title ?? `RootFS recipe: ${recipe.name ?? "builder"}`,
    rootfs_image: recipe.base?.image,
    rootfs_image_id: recipe.base?.image_id,
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
  api,
  moduleDir,
  recipeDir,
  step,
  stepIndex,
}: {
  api: any;
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
    return await execRecipeCommand({
      api,
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
  const script = run.script
    ? readFileSync(join(loaded.dir, run.script), "utf8")
    : run.command!;
  const result = await execRecipeCommand({
    api,
    env: recipeEnv(inputs, step.uses),
    name: step.name ?? step.uses,
    script,
    timeout: step.timeout,
  });
  if (result.exit_code !== 0) return result;
  const verify = loaded.module.verify;
  if (verify?.script || verify?.command) {
    const verifyScript = verify.script
      ? readFileSync(join(loaded.dir, verify.script), "utf8")
      : verify.command!;
    const verifyResult = await execRecipeCommand({
      api,
      env: recipeEnv(inputs, step.uses),
      name: `${step.name ?? step.uses} verify`,
      script: verifyScript,
      timeout: step.timeout,
    });
    if (verifyResult.exit_code !== 0) return verifyResult;
  }
  return result;
}

async function execRecipeCommand({
  api,
  env,
  name,
  script,
  timeout,
}: {
  api: any;
  env: Record<string, string>;
  name: string;
  script: string;
  timeout?: number;
}): Promise<RootfsRecipeStepResult> {
  const output = (await api.system.exec({
    bash: true,
    command: script,
    env,
    err_on_exit: false,
    max_output: 200_000,
    timeout: timeout ?? 900,
  })) as ExecuteCodeOutput;
  return {
    name,
    exit_code: output.exit_code,
    stdout: output.stdout,
    stderr: output.stderr,
  };
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
  recipeDir: string,
): string {
  if (requested) return resolve(requested);
  const envDir = `${process.env.COCALC_ROOTFS_RECIPE_MODULES ?? ""}`.trim();
  if (envDir) return resolve(envDir);
  let cur = recipeDir;
  while (cur !== dirname(cur)) {
    const candidate = join(cur, "src", "packages", "rootfs-recipes");
    if (existsSync(candidate)) return candidate;
    cur = dirname(cur);
  }
  return resolve(process.cwd(), "src", "packages", "rootfs-recipes");
}

function loadRecipeModule(id: string, moduleDir: string): LoadedModule {
  if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new Error(`invalid recipe module id '${id}'`);
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`recipe module '${id}' must be a JSON object`);
  }
  const module = parsed as RootfsRecipeModule;
  if (module.id !== id) {
    throw new Error(
      `recipe module ${path} has id '${module.id}', expected '${id}'`,
    );
  }
  return { dir, module };
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
      tags: publish.tags,
    },
    theme: publish.theme as any,
    content: publish.content as any,
  };
}

function resultContribution(
  step: RootfsRecipeStep,
  moduleDir: string,
): RootfsConfigExport {
  if (!step.uses) return emptyRecipeConfig({ version: 1 });
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
  return {
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
}
