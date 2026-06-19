import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import type { ExecuteCodeOutput } from "@cocalc/util/types/execute-code";

import type { RootfsConfigExport } from "@cocalc/util/rootfs-images";
import { parse as parseYaml } from "yaml";

type JsonObject = Record<string, any>;

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
  publish?: unknown;
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

type LoadedRecipe = {
  moduleDir: string;
  recipe: RootfsRecipe;
  recipeDir: string;
  recipePath: string;
};

const DEFAULT_RECIPE_COMMAND_TIMEOUT_SECONDS = 900;

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
      recipe: loadRootfsRecipe(examplePath),
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
  return candidates.find((id) =>
    existsSync(join(moduleDir, ...id.split("/"), "recipe.json")),
  );
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
    steps: [{ uses: module.id }],
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
    await phase(
      `wait for project host api for ${project.project_id}`,
      async () =>
        await resolved.api.waitUntilReady?.({ timeout: ctx.timeoutMs }),
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
          api: resolved.api,
          ctx,
          defaultCommandTimeout,
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
    }

    const verifyResults: RootfsRecipeStepResult[] = [];
    for (let i = 0; i < (recipe.verify ?? []).length; i += 1) {
      const verify = recipe.verify![i];
      emitRecipeProgress(
        ctx,
        `running top-level verification ${i + 1}/${recipe.verify!.length}`,
      );
      const result = await execRecipeCommand({
        api: resolved.api,
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
  api,
  ctx,
  defaultCommandTimeout,
  moduleDir,
  recipeDir,
  step,
  stepIndex,
}: {
  api: any;
  ctx: any;
  defaultCommandTimeout: number;
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
      ctx,
      defaultTimeout: defaultCommandTimeout,
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
    ctx,
    defaultTimeout: defaultCommandTimeout,
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
      ctx,
      defaultTimeout: defaultCommandTimeout,
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
  ctx,
  defaultTimeout,
  env,
  name,
  script,
  timeout,
}: {
  api: any;
  ctx: any;
  defaultTimeout: number;
  env: Record<string, string>;
  name: string;
  script: string;
  timeout?: number;
}): Promise<RootfsRecipeStepResult> {
  const commandTimeout = timeout ?? defaultTimeout;
  const started = Date.now();
  const initial = (await api.system.exec({
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
  emitRecipeOutput(ctx, name, last, offsets);
  while (Date.now() - started <= commandTimeout * 1000 + 5_000) {
    await sleep(Math.max(250, Number(ctx.pollMs ?? 1000)));
    last = (await api.system.exec({
      async_get: initial.job_id,
    })) as ExecuteCodeOutput;
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
