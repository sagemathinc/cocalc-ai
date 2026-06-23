import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import type { ProjectRootfsPublishConfig } from "@cocalc/conat/hub/api/projects";
import type {
  RootfsConfigExport,
  RootfsAdminCatalogEntry,
  RootfsDeleteRequestResult,
  RootfsImageEntry,
  RootfsImageEvent,
  RootfsImageArch,
  RootfsImageSection,
  RootfsImageTheme,
  RootfsImageVisibility,
  RootfsReleaseGcRunResult,
  RootfsRusticRepoListResult,
} from "@cocalc/util/rootfs-images";
import { parseRootfsConfigExport } from "@cocalc/util/rootfs-images";
import type { RootfsReleaseScanRun } from "@cocalc/util/rootfs-scan";
import { emitSuccess } from "../core/cli-output";
import {
  explainRootfsRecipe,
  listRootfsRecipes,
  renderRootfsRecipeDryRunScript,
  resolveRootfsRecipeBuildPlan,
  runRootfsRecipe,
  type RootfsRecipeBuildPlan,
  type RootfsRecipeRunResult,
  type RootfsRecipeRunOptions,
} from "./rootfs-recipe";

export type RootfsCommandDeps = {
  withContext: any;
  resolveProjectFromArgOrContext: any;
  resolveProjectProjectApi: any;
  waitForLro: any;
  serializeLroSummary: any;
};

function parseLimit(value?: string, fallback = 100): number {
  return Math.max(1, Math.min(10_000, Number(value ?? fallback) || fallback));
}

type LastRootfsBuild = {
  version: 1;
  api?: string;
  account_id?: string;
  project_id: string;
  build_id: string;
  recipe?: string;
  host_id?: string;
  saved_at: string;
};

function rootfsBuildStateFile(): string {
  const explicit = process.env.COCALC_ROOTFS_BUILD_STATE_FILE?.trim();
  if (explicit) return explicit;
  return join(
    homedir() || process.cwd(),
    ".local",
    "share",
    "cocalc",
    "rootfs-builds",
    "last.json",
  );
}

function contextScope(ctx: any): { api?: string; account_id?: string } {
  return {
    api: `${ctx?.apiBaseUrl ?? ""}`.trim() || undefined,
    account_id: `${ctx?.accountId ?? ""}`.trim() || undefined,
  };
}

function readLastRootfsBuild(ctx: any): LastRootfsBuild | undefined {
  const path = rootfsBuildStateFile();
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    if (
      parsed.version !== 1 ||
      typeof parsed.project_id !== "string" ||
      typeof parsed.build_id !== "string"
    ) {
      return undefined;
    }
    const scope = contextScope(ctx);
    if (scope.api && parsed.api && scope.api !== parsed.api) {
      return undefined;
    }
    if (
      scope.account_id &&
      parsed.account_id &&
      scope.account_id !== parsed.account_id
    ) {
      return undefined;
    }
    return parsed as LastRootfsBuild;
  } catch {
    return undefined;
  }
}

function writeLastRootfsBuild({
  ctx,
  project_id,
  build,
  recipe,
}: {
  ctx: any;
  project_id: string;
  build: any;
  recipe: string;
}): void {
  const build_id = `${build?.build_id ?? ""}`.trim();
  if (!project_id || !build_id) return;
  const path = rootfsBuildStateFile();
  const row: LastRootfsBuild = {
    version: 1,
    ...contextScope(ctx),
    project_id,
    build_id,
    recipe,
    host_id: `${build?.host_id ?? ""}`.trim() || undefined,
    saved_at: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(row, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, path);
}

function resolveLastRootfsBuildProject(ctx: any, project?: string): string {
  const explicit = `${project ?? ""}`.trim();
  if (explicit) return explicit;
  const last = readLastRootfsBuild(ctx);
  if (last?.project_id) return last.project_id;
  throw new Error(
    "--project is required; or first run `cocalc rootfs build ...` to record the last build",
  );
}

function resolveLastRootfsBuildId(ctx: any, build_id?: string): string {
  const explicit = `${build_id ?? ""}`.trim();
  if (explicit) return explicit;
  const last = readLastRootfsBuild(ctx);
  if (last?.build_id) return last.build_id;
  throw new Error(
    "build id is required; or first run `cocalc rootfs build ...` to record the last build",
  );
}

async function resolveRootfsBuildProject({
  ctx,
  resolveProjectFromArgOrContext,
  project,
}: {
  ctx: any;
  resolveProjectFromArgOrContext: any;
  project?: string;
}): Promise<{ project_id: string }> {
  return await resolveProjectFromArgOrContext(
    ctx,
    resolveLastRootfsBuildProject(ctx, project),
  );
}

function bytes(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let x = n;
  let unit = 0;
  while (x >= 1024 && unit < units.length - 1) {
    x /= 1024;
    unit += 1;
  }
  return `${x.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatRootfsRecipeListHuman(
  result: ReturnType<typeof listRootfsRecipes>,
): string {
  const lines = [`Module directory: ${result.module_dir}`, "", "Recipes:"];
  if (result.examples.length === 0) {
    lines.push("  (none)");
  } else {
    for (const recipe of result.examples) {
      lines.push(`  ${recipe.name}${recipe.label ? ` - ${recipe.label}` : ""}`);
    }
  }
  lines.push("", "Modules:");
  if (result.modules.length === 0) {
    lines.push("  (none)");
  } else {
    for (const module of result.modules) {
      lines.push(
        `  ${module.id}${module.description ? ` - ${module.description}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function formatRootfsRecipeRunHuman(result: RootfsRecipeRunResult): string {
  const lines = [
    `recipe: ${result.recipe}`,
    `recipe_path: ${result.recipe_path}`,
    `project_id: ${result.project_id}`,
    `created_project: ${result.created_project}`,
  ];
  if (result.config_path) {
    lines.push(`config_path: ${result.config_path}`);
  }
  if (result.steps.length > 0) {
    lines.push("steps:");
    for (const step of result.steps) {
      lines.push(`  - ${step.name}: ${formatExitCode(step.exit_code)}`);
    }
  }
  if (result.verify.length > 0) {
    lines.push("verify:");
    for (const step of result.verify) {
      lines.push(`  - ${step.name}: ${formatExitCode(step.exit_code)}`);
    }
  }
  const metadata = result.config.metadata ?? {};
  const content =
    result.config.content &&
    typeof result.config.content === "object" &&
    !Array.isArray(result.config.content)
      ? (result.config.content as Record<string, unknown>)
      : {};
  const actions = Array.isArray(content.actions) ? content.actions : [];
  lines.push(
    "config:",
    `  label: ${metadata.label ?? "-"}`,
    `  title: ${content.title ?? "-"}`,
    `  tags: ${(metadata.tags ?? []).join(", ") || "-"}`,
    `  actions: ${actions.length}`,
  );
  if (result.publish != null) {
    lines.push(`publish: ${formatPublishSummary(result.publish)}`);
  }
  return lines.join("\n");
}

function formatExitCode(exitCode: number): string {
  return exitCode === 0 ? "ok" : `exit ${exitCode}`;
}

function formatPublishSummary(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${value}`;
  }
  const publish = value as Record<string, unknown>;
  const fields = ["status", "op_id", "scope_type", "scope_id"].flatMap(
    (field) =>
      publish[field] == null ? [] : [`${field}=${String(publish[field])}`],
  );
  return fields.length > 0 ? fields.join(" ") : JSON.stringify(publish);
}

function parseVisibility(value?: string): RootfsImageVisibility | undefined {
  const trimmed = `${value ?? ""}`.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (
    trimmed === "private" ||
    trimmed === "collaborators" ||
    trimmed === "public"
  ) {
    return trimmed;
  }
  throw new Error(
    `invalid visibility '${value}'; expected private, collaborators, or public`,
  );
}

function parseTags(value?: string): string[] | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  const tags = Array.from(
    new Set(
      trimmed
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
  return tags.length ? tags : undefined;
}

function parseArch(value?: string): RootfsImageArch | undefined {
  const trimmed = `${value ?? ""}`.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === "amd64" || trimmed === "arm64" || trimmed === "any") {
    return trimmed;
  }
  throw new Error(`invalid arch '${value}'; expected amd64, arm64, or any`);
}

function parseOptionalNumber(
  value?: string,
  label = "value",
): number | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return n;
}

function parseThemeJson(value?: string): RootfsImageTheme | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`invalid --theme-json: ${err}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--theme-json must be a JSON object");
  }
  return parsed as RootfsImageTheme;
}

function parseRootfsConfigFile(value?: string): RootfsConfigExport | undefined {
  const path = `${value ?? ""}`.trim();
  if (!path) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`invalid --config-file: ${err}`);
  }
  try {
    return parseRootfsConfigExport(parsed);
  } catch (err) {
    throw new Error(`invalid --config-file: ${err}`);
  }
}

function projectRootfsPublishConfigEnvelope(
  result: Pick<RootfsRecipeRunResult, "recipe" | "recipe_path" | "config">,
): ProjectRootfsPublishConfig {
  return {
    kind: "cocalc-project-rootfs-publish-config",
    version: 1,
    updated_at: new Date().toISOString(),
    recipe: {
      name: result.recipe,
      recipe_path: result.recipe_path,
    },
    config: result.config,
  };
}

async function startRootfsBuilderProject({
  ctx,
  deps,
  options,
  plan,
}: {
  ctx: any;
  deps: RootfsCommandDeps;
  options: RootfsRecipeRunOptions;
  plan: RootfsRecipeBuildPlan;
}): Promise<{ project_id: string; created_project: boolean }> {
  if (options.project) {
    const project = await deps.resolveProjectFromArgOrContext(
      ctx,
      options.project,
    );
    await waitForProjectStart({ ctx, deps, project_id: project.project_id });
    return { project_id: project.project_id, created_project: false };
  }
  const project_id = await ctx.hub.projects.createProject({
    title: options.title ?? `RootFS build: ${plan.recipe}`,
    rootfs_image: plan.base?.image,
    rootfs_image_id: plan.base?.image_id,
    run_quota: plan.builder?.run_quota,
    start: false,
  });
  await waitForProjectStart({ ctx, deps, project_id });
  return { project_id, created_project: true };
}

async function waitForProjectStart({
  ctx,
  deps,
  project_id,
}: {
  ctx: any;
  deps: RootfsCommandDeps;
  project_id: string;
}): Promise<void> {
  const op = await ctx.hub.projects.start({ project_id, wait: false });
  const waited = await deps.waitForLro(ctx, op.op_id, {
    timeoutMs: ctx.timeoutMs,
    pollMs: ctx.pollMs,
  });
  if (waited.timedOut) {
    throw new Error(
      `timeout waiting for rootfs build project start op ${op.op_id}; last_status=${waited.status}`,
    );
  }
  if (waited.status !== "succeeded" && waited.status !== "done") {
    throw new Error(
      `rootfs build project start failed: status=${waited.status} error=${waited.error ?? "unknown"}`,
    );
  }
}

const ROOTFS_BUILD_TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "canceled",
  "unknown",
]);
const ROOTFS_BUILD_FRESH_HEARTBEAT_MS = 120_000;

function ageSeconds(iso?: string): number | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, Math.floor((Date.now() - time) / 1000));
}

function formatAge(iso?: string): string | undefined {
  const age = ageSeconds(iso);
  return age == null ? undefined : `${age}s ago`;
}

function heartbeatFresh(status: any): boolean | undefined {
  if (!status?.heartbeat_at) return undefined;
  const time = Date.parse(status.heartbeat_at);
  if (!Number.isFinite(time)) return undefined;
  return Date.now() - time <= ROOTFS_BUILD_FRESH_HEARTBEAT_MS;
}

async function followRootfsBuildLog({
  ctx,
  deps,
  project_id,
  build_id,
  byte_offset = 0,
}: {
  ctx: any;
  deps: RootfsCommandDeps;
  project_id: string;
  build_id: string;
  byte_offset?: number;
}) {
  let byteOffset = byte_offset;
  const { api } = await deps.resolveProjectProjectApi(ctx, project_id);
  while (true) {
    const chunk = await readRootfsBuildLogDirect({
      api,
      ctx,
      project_id,
      build_id,
      byte_offset: byteOffset,
      max_bytes: 128 * 1024,
    });
    if (
      chunk.text &&
      !ctx.globals?.quiet &&
      !ctx.globals?.json &&
      ctx.globals?.output !== "json"
    ) {
      process.stderr.write(chunk.text);
    }
    byteOffset = chunk.next_byte_offset ?? byteOffset;
    const current = await ctx.hub.projects.getProjectRootfsBuildStatus({
      project_id,
      build_id,
    });
    const status = current.status ?? "unknown";
    if (ROOTFS_BUILD_TERMINAL_STATUSES.has(status)) {
      return current;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(250, Number(ctx.pollMs ?? 1000))),
    );
  }
}

async function readRootfsBuildLogDirect({
  api,
  ctx,
  project_id,
  build_id,
  lines,
  byte_offset,
  max_bytes,
}: {
  api: any;
  ctx: any;
  project_id: string;
  build_id: string;
  lines?: number;
  byte_offset?: number;
  max_bytes?: number;
}) {
  try {
    return await api.system.readRootfsBuildLog({
      build_id,
      lines,
      byte_offset,
      max_bytes,
    });
  } catch (err) {
    if (!isMissingDirectRootfsBuildLogApi(err)) {
      throw err;
    }
    return await ctx.hub.projects.getProjectRootfsBuildLog({
      project_id,
      build_id,
      lines,
      byte_offset,
      max_bytes,
    });
  }
}

async function readRootfsBuildEventsDirect({
  api,
  build_id,
  lines,
  byte_offset,
  max_bytes,
}: {
  api: any;
  build_id: string;
  lines?: number;
  byte_offset?: number;
  max_bytes?: number;
}) {
  return await api.system.readRootfsBuildEvents({
    build_id,
    lines,
    byte_offset,
    max_bytes,
  });
}

function isMissingDirectRootfsBuildLogApi(err: unknown): boolean {
  return /unknown function 'system\.readRootfsBuildLog'|readRootfsBuildLog is not a function/i.test(
    `${err}`,
  );
}

function parseNdjson(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch (err) {
      events.push({ parse_error: `${err}`, raw: line });
    }
  }
  return events;
}

async function followRootfsBuildEvents({
  ctx,
  deps,
  project_id,
  build_id,
  byte_offset = 0,
}: {
  ctx: any;
  deps: RootfsCommandDeps;
  project_id: string;
  build_id: string;
  byte_offset?: number;
}) {
  let byteOffset = byte_offset;
  const { api } = await deps.resolveProjectProjectApi(ctx, project_id);
  while (true) {
    const chunk = await readRootfsBuildEventsDirect({
      api,
      build_id,
      byte_offset: byteOffset,
      max_bytes: 64 * 1024,
    });
    if (
      chunk.text &&
      !ctx.globals?.quiet &&
      !ctx.globals?.json &&
      ctx.globals?.output !== "json"
    ) {
      process.stderr.write(chunk.text);
      if (!chunk.text.endsWith("\n")) {
        process.stderr.write("\n");
      }
    }
    byteOffset = chunk.next_byte_offset ?? byteOffset;
    const current = await ctx.hub.projects.getProjectRootfsBuildStatus({
      project_id,
      build_id,
    });
    const status = current.status ?? "unknown";
    if (ROOTFS_BUILD_TERMINAL_STATUSES.has(status)) {
      return current;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(250, Number(ctx.pollMs ?? 1000))),
    );
  }
}

function formatRootfsBuildStartHuman(result: {
  recipe: string;
  recipe_path: string;
  project_id: string;
  created_project: boolean;
  build: any;
  saved_rootfs_publish_config: boolean;
}): string {
  const lines = [
    `recipe: ${result.recipe}`,
    `recipe_path: ${result.recipe_path}`,
    `project_id: ${result.project_id}`,
    `created_project: ${result.created_project}`,
    `build_id: ${result.build.build_id}`,
    `host_id: ${result.build.host_id}`,
    `status: ${result.build.status}`,
  ];
  if (result.build.paths?.log) {
    lines.push(`log_path: ${result.build.paths.log}`);
  }
  if (result.build.paths?.script) {
    lines.push(`script_path: ${result.build.paths.script}`);
  }
  lines.push(
    `saved_rootfs_publish_config: ${result.saved_rootfs_publish_config}`,
    `status: cocalc rootfs build-status ${result.build.build_id}`,
    `logs: cocalc rootfs build-logs ${result.build.build_id} --follow`,
    `next: cocalc rootfs publish --project=${result.project_id}`,
  );
  return lines.join("\n");
}

function formatRootfsBuildStatusHuman(status: any): string {
  const lines = [
    `build_id: ${status.build_id}`,
    `project_id: ${status.project_id}`,
    `host_id: ${status.host_id}`,
    `status: ${status.status}`,
  ];
  if (status.recipe_ref) {
    lines.push(`recipe: ${status.recipe_ref}`);
  }
  if (status.created_at) {
    lines.push(`created_at: ${status.created_at}`);
  }
  if (status.started_at) {
    lines.push(`started_at: ${status.started_at}`);
  }
  if (status.finished_at) {
    lines.push(`finished_at: ${status.finished_at}`);
  }
  if (status.heartbeat_at) {
    const heartbeatAge = formatAge(status.heartbeat_at);
    const fresh = heartbeatFresh(status);
    lines.push(
      `heartbeat_at: ${status.heartbeat_at}${heartbeatAge ? ` (${heartbeatAge})` : ""}`,
    );
    if (fresh != null) {
      lines.push(`heartbeat_fresh: ${fresh}`);
    }
  }
  if (status.last_output_at) {
    const outputAge = formatAge(status.last_output_at);
    lines.push(
      `last_output_at: ${status.last_output_at}${outputAge ? ` (${outputAge})` : ""}`,
    );
  }
  if (status.pid != null) {
    lines.push(`pid: ${status.pid}`);
  }
  if (status.exit_code != null) {
    lines.push(`exit_code: ${status.exit_code}`);
  }
  if (status.signal) {
    lines.push(`signal: ${status.signal}`);
  }
  if (status.error) {
    lines.push(`error: ${status.error}`);
  }
  if (status.paths?.log) {
    lines.push(`log_path: ${status.paths.log}`);
  }
  if (status.paths?.events) {
    lines.push(`events_path: ${status.paths.events}`);
  }
  if (status.paths?.runner) {
    lines.push(`runner_path: ${status.paths.runner}`);
  }
  if (status.paths?.script) {
    lines.push(`script_path: ${status.paths.script}`);
  }
  return lines.join("\n");
}

function formatRootfsBuildListHuman({
  project_id,
  builds,
}: {
  project_id: string;
  builds: any[];
}): string {
  const lines = [`project_id: ${project_id}`, `builds: ${builds.length}`];
  for (const build of builds) {
    const parts = [
      build.build_id,
      build.status,
      build.recipe_ref ? `recipe=${build.recipe_ref}` : undefined,
      build.pid != null ? `pid=${build.pid}` : undefined,
      build.heartbeat_at
        ? `heartbeat=${formatAge(build.heartbeat_at) ?? build.heartbeat_at}`
        : undefined,
      heartbeatFresh(build) != null
        ? `fresh=${heartbeatFresh(build)}`
        : undefined,
      build.created_at ? `created=${build.created_at}` : undefined,
      build.finished_at ? `finished=${build.finished_at}` : undefined,
      build.paths?.log ? `log=${build.paths.log}` : undefined,
    ].filter(Boolean);
    lines.push(parts.join("  "));
  }
  return lines.join("\n");
}

async function rootfsPublishConfigForProject({
  ctx,
  configFile,
  project_id,
}: {
  ctx: any;
  configFile?: string;
  project_id: string;
}): Promise<RootfsConfigExport | undefined> {
  const fileConfig = parseRootfsConfigFile(configFile);
  if (fileConfig != null) return fileConfig;
  const saved = await ctx.hub.projects.getProjectRootfsPublishConfig?.({
    project_id,
  });
  return saved?.config == null
    ? undefined
    : parseRootfsConfigExport(saved.config);
}

function rootfsCatalogConfigPayload(
  opts: {
    label?: string;
    slug?: string;
    family?: string;
    imageVersion?: string;
    channel?: string;
    supersedesImageId?: string;
    description?: string;
    visibility?: string;
    tags?: string;
    themeJson?: string;
    arch?: string;
    gpu?: boolean;
    sizeGb?: string;
  },
  config?: RootfsConfigExport,
) {
  const label = `${opts.label ?? config?.metadata?.label ?? ""}`.trim();
  if (!label) {
    throw new Error(
      "missing RootFS label; pass --label, --config-file, or first run rootfs build for this project",
    );
  }
  const content =
    config?.content != null
      ? { content: config.content, content_warnings: [] }
      : {};
  return {
    label,
    slug: opts.slug ?? config?.metadata?.slug,
    family: opts.family ?? config?.metadata?.family,
    version: opts.imageVersion ?? config?.metadata?.version,
    channel: opts.channel ?? config?.metadata?.channel,
    supersedes_image_id:
      opts.supersedesImageId ?? config?.metadata?.supersedes_image_id,
    description: opts.description ?? config?.metadata?.description,
    visibility:
      opts.visibility != null
        ? parseVisibility(opts.visibility)
        : config?.metadata?.visibility,
    tags: opts.tags != null ? parseTags(opts.tags) : config?.metadata?.tags,
    theme:
      opts.themeJson != null ? parseThemeJson(opts.themeJson) : config?.theme,
    arch: parseArch(opts.arch),
    gpu: opts.gpu === true ? true : undefined,
    size_gb: parseOptionalNumber(opts.sizeGb, "--size-gb"),
    ...content,
  };
}

function normalizeSection(value?: string): RootfsImageSection | undefined {
  const trimmed = `${value ?? ""}`.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (
    trimmed === "official" ||
    trimmed === "mine" ||
    trimmed === "collaborators" ||
    trimmed === "public"
  ) {
    return trimmed;
  }
  throw new Error(
    `invalid section '${value}'; expected official, mine, collaborators, or public`,
  );
}

function serializeRootfsImageEntry(entry: RootfsImageEntry) {
  return {
    image_id: entry.id,
    slug: entry.slug ?? null,
    label: entry.label,
    image: entry.image,
    family: entry.family ?? null,
    version: entry.version ?? null,
    channel: entry.channel ?? null,
    supersedes_image_id: entry.supersedes_image_id ?? null,
    section: entry.section ?? null,
    visibility: entry.visibility ?? null,
    official: !!entry.official,
    prepull: !!entry.prepull,
    hidden: !!entry.hidden,
    blocked: !!entry.blocked,
    blocked_reason: entry.blocked_reason ?? null,
    digest: entry.digest ?? null,
    arch: entry.arch ?? null,
    gpu: !!entry.gpu,
    size_gb: entry.size_gb ?? null,
    owner_id: entry.owner_id ?? null,
    owner_name: entry.owner_name ?? null,
    warning: entry.warning ?? null,
    description: entry.description ?? null,
    tags: entry.tags ?? [],
    can_manage: !!entry.can_manage,
    scan: entry.scan ?? null,
  };
}

function serializeRootfsAdminEntry(entry: RootfsAdminCatalogEntry) {
  return {
    ...serializeRootfsImageEntry(entry),
    deleted: !!entry.deleted,
    deleted_reason: entry.deleted_reason ?? null,
    hidden_at: entry.hidden_at ?? null,
    hidden_by: entry.hidden_by ?? null,
    blocked_at: entry.blocked_at ?? null,
    blocked_by: entry.blocked_by ?? null,
    deleted_at: entry.deleted_at ?? null,
    deleted_by: entry.deleted_by ?? null,
    release_id: entry.release_id ?? null,
    release_gc_status: entry.release_gc_status ?? null,
    storage_locations: entry.storage_locations ?? [],
    delete_blockers: entry.delete_blockers ?? null,
    scan_status: entry.scan_status ?? null,
    scan_tool: entry.scan_tool ?? null,
    scanned_at: entry.scanned_at ?? null,
    events: entry.events ?? [],
  };
}

function formatRootfsEventHuman(event: RootfsImageEvent): string {
  const who = event.actor_name ?? event.actor_account_id ?? "-";
  const details =
    event.reason ??
    event.payload?.blocked_reason ??
    (event.payload?.blockers?.total != null
      ? `blockers=${event.payload.blockers.total}`
      : "");
  return `${event.created} ${event.event_type} by ${who}${details ? ` (${details})` : ""}`;
}

function wrapField({
  label,
  value,
  indent = "   ",
  width = 96,
}: {
  label: string;
  value?: unknown;
  indent?: string;
  width?: number;
}): string[] {
  const text = `${value ?? ""}`.trim();
  if (!text) return [];
  const prefix = `${indent}${label}: `;
  const maxWidth = Math.max(prefix.length + 10, width);
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = prefix;
  for (const word of words) {
    const candidate =
      current === prefix ? `${prefix}${word}` : `${current} ${word}`;
    if (candidate.length <= maxWidth || current === prefix) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = `${" ".repeat(prefix.length)}${word}`;
  }
  lines.push(current);
  return lines;
}

function formatRootfsEntriesHuman(
  entries: Array<ReturnType<typeof serializeRootfsImageEntry>>,
): string {
  if (!entries.length) {
    return "(no rootfs images)";
  }
  return entries
    .map((entry, index) => {
      const header = `${index + 1}. ${entry.label}`;
      const lines = [
        header,
        `   id: ${entry.image_id}`,
        `   image: ${entry.image}`,
        `   section: ${entry.section ?? "-"}`,
        `   visibility: ${entry.visibility ?? "-"}`,
        `   owner: ${entry.owner_name ?? entry.owner_id ?? "-"}`,
        `   flags: official=${entry.official} prepull=${entry.prepull} hidden=${entry.hidden} blocked=${entry.blocked} gpu=${entry.gpu} can_manage=${entry.can_manage}`,
      ];
      if (entry.arch != null) {
        const arch = Array.isArray(entry.arch)
          ? entry.arch.join(", ")
          : `${entry.arch}`;
        lines.push(`   arch: ${arch}`);
      }
      if (entry.digest) {
        lines.push(`   digest: ${entry.digest}`);
      }
      if (entry.family || entry.version || entry.channel) {
        lines.push(
          `   release: family=${entry.family ?? "-"} version=${entry.version ?? "-"} channel=${entry.channel ?? "-"}`,
        );
      }
      if (entry.supersedes_image_id) {
        lines.push(`   supersedes: ${entry.supersedes_image_id}`);
      }
      if (entry.size_gb != null) {
        lines.push(`   size_gb: ${entry.size_gb}`);
      }
      if (entry.warning && entry.warning !== "none") {
        lines.push(`   warning: ${entry.warning}`);
      }
      if (entry.scan?.status && entry.scan.status !== "unknown") {
        lines.push(
          `   scan: status=${entry.scan.status} tool=${entry.scan.tool ?? "-"} scanned_at=${entry.scan.scanned_at ?? "-"}`,
        );
      }
      lines.push(
        ...wrapField({
          label: "description",
          value: entry.description,
        }),
      );
      lines.push(
        ...wrapField({
          label: "tags",
          value: Array.isArray(entry.tags) ? entry.tags.join(", ") : "",
        }),
      );
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatRootfsAdminEntriesHuman(
  entries: Array<ReturnType<typeof serializeRootfsAdminEntry>>,
): string {
  if (!entries.length) {
    return "(no rootfs images)";
  }
  return entries
    .map((entry, index) => {
      const header = `${index + 1}. ${entry.label}`;
      const lines = [
        header,
        `   id: ${entry.image_id}`,
        `   image: ${entry.image}`,
        `   owner: ${entry.owner_name ?? entry.owner_id ?? "-"}`,
        `   visibility: ${entry.visibility ?? "-"}`,
        `   release_id: ${entry.release_id ?? "-"}`,
        `   lifecycle: hidden=${entry.hidden} blocked=${entry.blocked} deleted=${entry.deleted} release_gc_status=${entry.release_gc_status ?? "-"}`,
      ];
      if (entry.blocked && entry.blocked_reason) {
        lines.push(`   blocked_reason: ${entry.blocked_reason}`);
      }
      if (entry.family || entry.version || entry.channel) {
        lines.push(
          `   release: family=${entry.family ?? "-"} version=${entry.version ?? "-"} channel=${entry.channel ?? "-"}`,
        );
      }
      if (entry.supersedes_image_id) {
        lines.push(`   supersedes: ${entry.supersedes_image_id}`);
      }
      if (entry.blocked_at || entry.blocked_by) {
        lines.push(
          `   last_blocked: ${entry.blocked_at ?? "-"} by ${entry.blocked_by ?? "-"}`,
        );
      }
      if (entry.hidden_at || entry.hidden_by) {
        lines.push(
          `   last_hidden: ${entry.hidden_at ?? "-"} by ${entry.hidden_by ?? "-"}`,
        );
      }
      if (entry.deleted_at || entry.deleted_by) {
        lines.push(
          `   deleted_at: ${entry.deleted_at ?? "-"} by ${entry.deleted_by ?? "-"}`,
        );
      }
      if (entry.delete_blockers) {
        lines.push(
          `   delete_blockers: total=${entry.delete_blockers.total} projects=${entry.delete_blockers.projects_using_release} catalog=${entry.delete_blockers.catalog_entries_using_release} prepull=${entry.delete_blockers.prepull_entries_using_release} child_releases=${entry.delete_blockers.child_releases}`,
        );
      }
      if (entry.scan_status || entry.scan_tool || entry.scanned_at) {
        lines.push(
          `   scan: status=${entry.scan_status ?? "unknown"} tool=${entry.scan_tool ?? "-"} scanned_at=${entry.scanned_at ?? "-"}`,
        );
      }
      if (entry.scan?.summary) {
        lines.push(`   scan_summary: ${entry.scan.summary}`);
      }
      if (entry.scan?.report_url) {
        lines.push(`   scan_report: ${entry.scan.report_url}`);
      }
      if (entry.storage_locations?.length) {
        lines.push("   storage:");
        for (const location of entry.storage_locations) {
          const parts = [
            location.role,
            location.repo_selector ?? location.backend,
          ];
          if (location.region) parts.push(`region=${location.region}`);
          if (location.repo_id) parts.push(`repo_id=${location.repo_id}`);
          if (location.status) parts.push(`status=${location.status}`);
          lines.push(`     - ${parts.join(" ")}`);
        }
      }
      if (entry.events?.length) {
        lines.push("   recent_events:");
        for (const event of entry.events) {
          lines.push(`     - ${formatRootfsEventHuman(event)}`);
        }
      }
      lines.push(
        ...wrapField({
          label: "description",
          value: entry.description,
        }),
      );
      lines.push(
        ...wrapField({
          label: "tags",
          value: Array.isArray(entry.tags) ? entry.tags.join(", ") : "",
        }),
      );
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatRootfsDeleteResultHuman(
  result: RootfsDeleteRequestResult,
): string {
  const lines = [
    `image_id: ${result.image_id}`,
    `image: ${result.image}`,
    `hidden: ${result.hidden}`,
    `deleted: ${result.deleted}`,
    `delete_requested: ${result.delete_requested}`,
    `release_id: ${result.release_id ?? "-"}`,
    `release_gc_status: ${result.release_gc_status ?? "-"}`,
    `blockers: total=${result.blockers.total} projects=${result.blockers.projects_using_release} catalog=${result.blockers.catalog_entries_using_release} prepull=${result.blockers.prepull_entries_using_release} child_releases=${result.blockers.child_releases}`,
  ];
  return lines.join("\n");
}

function formatRootfsGcResultHuman(result: RootfsReleaseGcRunResult): string {
  const lines = [
    `scanned: ${result.scanned}`,
    `deleted: ${result.deleted}`,
    `blocked: ${result.blocked}`,
    `failed: ${result.failed}`,
  ];
  for (const item of result.items) {
    lines.push(
      "",
      `${item.release_id} ${item.status} ${item.image || item.content_key}`,
    );
    if (item.deleted_replicas != null) {
      lines.push(`  deleted_replicas: ${item.deleted_replicas}`);
    }
    if (item.blockers) {
      lines.push(
        `  blockers: total=${item.blockers.total} projects=${item.blockers.projects_using_release} catalog=${item.blockers.catalog_entries_using_release} prepull=${item.blockers.prepull_entries_using_release} child_releases=${item.blockers.child_releases}`,
      );
    }
    if (item.error) {
      lines.push(`  error: ${item.error}`);
    }
  }
  return lines.join("\n");
}

function formatRootfsRusticReposHuman(
  result: RootfsRusticRepoListResult,
): string {
  const byRegion = new Map<string, typeof result.repos>();
  for (const repo of result.repos) {
    const region = repo.region || "unknown";
    const rows = byRegion.get(region) ?? [];
    rows.push(repo);
    byRegion.set(region, rows);
  }
  const lines = [
    `active_shards_per_region: ${result.active_shards_per_region}`,
    `releases_per_shard: ${result.releases_per_shard}`,
    `repos: ${result.repos.length}`,
    "status: active accepts new artifacts; sealed is read-only; draining is operator repair/migration; disabled is unavailable for assignment.",
  ];
  if (
    result.legacy.artifact_count > 0 ||
    result.legacy.r2_object_count != null
  ) {
    lines.push(
      `legacy_single_repo: ${result.legacy.artifact_count} DB artifacts, ${bytes(result.legacy.artifact_bytes)} DB bytes${result.legacy.r2_object_count != null ? `; R2 ${result.legacy.r2_object_count} objects, ${bytes(result.legacy.r2_total_bytes)}` : ""}; temporary read compatibility is still in use`,
    );
  }
  if (result.orphan_r2_repos?.length) {
    lines.push("orphan_r2_rootfs_repos:");
    for (const repo of result.orphan_r2_repos) {
      lines.push(
        `  - ${repo.repo} bucket=${repo.bucket_name ?? "-"} objects=${repo.object_count} total=${bytes(repo.total_bytes)}`,
      );
    }
  }
  for (const [region, repos] of [...byRegion.entries()].sort()) {
    lines.push("", `region ${region}:`);
    for (const repo of repos) {
      const r2 =
        repo.r2_object_count != null
          ? `; R2 ${repo.r2_object_count} objects, ${bytes(repo.r2_total_bytes)}`
          : "";
      lines.push(
        `  ${repo.status} ${repo.assigned_artifact_count}/${repo.cap} (${repo.available_slots} slots free, ${bytes(repo.artifact_bytes)} DB bytes${r2})`,
        `    repo_id: ${repo.id}`,
        `    root: ${repo.root}`,
      );
      if (repo.bucket_name || repo.bucket_id) {
        lines.push(
          `    bucket: ${repo.bucket_name ?? "-"}${repo.bucket_id ? ` (${repo.bucket_id})` : ""}`,
        );
      }
      lines.push(`    updated: ${repo.updated ?? "-"}`);
    }
  }
  return lines.join("\n");
}

async function enrichRootfsRusticReposWithR2Audit({
  ctx,
  result,
  refresh,
  maxAgeMinutes,
}: {
  ctx: any;
  result: RootfsRusticRepoListResult;
  refresh?: boolean;
  maxAgeMinutes?: number;
}): Promise<RootfsRusticRepoListResult> {
  const repos = result.repos.map((repo) => ({ ...repo }));
  const knownRoots = new Set(repos.map((repo) => repo.root).filter(Boolean));
  const byRoot = new Map(repos.map((repo) => [repo.root, repo]));
  const buckets = Array.from(
    new Set(repos.map((repo) => repo.bucket_name).filter(Boolean)),
  );
  const orphan_r2_repos: NonNullable<
    RootfsRusticRepoListResult["orphan_r2_repos"]
  > = [];
  const legacy = { ...result.legacy };
  for (const bucket of buckets) {
    const audit = await ctx.hub.system.auditCloudflareR2Bucket({
      bucket,
      prefix: "rustic/rootfs-images",
      refresh,
      max_age_minutes: maxAgeMinutes,
    });
    for (const row of audit.rustic_repos ?? []) {
      if (row.kind !== "rootfs") continue;
      const repo = `${row.repo ?? ""}`.trim();
      if (repo === "rustic/rootfs-images") {
        legacy.r2_object_count =
          (legacy.r2_object_count ?? 0) + Number(row.object_count ?? 0);
        legacy.r2_total_bytes =
          (legacy.r2_total_bytes ?? 0) + Number(row.total_bytes ?? 0);
        continue;
      }
      const match = byRoot.get(repo);
      if (match) {
        match.r2_object_count =
          (match.r2_object_count ?? 0) + Number(row.object_count ?? 0);
        match.r2_total_bytes =
          (match.r2_total_bytes ?? 0) + Number(row.total_bytes ?? 0);
      } else if (!knownRoots.has(repo)) {
        orphan_r2_repos.push({
          bucket_name: bucket,
          repo,
          object_count: Number(row.object_count ?? 0),
          total_bytes: Number(row.total_bytes ?? 0),
        });
      }
    }
  }
  return {
    ...result,
    repos,
    legacy,
    orphan_r2_repos,
  };
}

function formatRootfsScanResultHuman(result: RootfsReleaseScanRun): string {
  const counts = result.severity_counts ?? result.summary?.severity_counts;
  const lines = [
    `scan_run_id: ${result.scan_run_id}`,
    `release_id: ${result.release_id}`,
    `image: ${result.runtime_image}`,
    `status: ${result.status}`,
    `host_id: ${result.host_id ?? "-"}`,
    `tool: ${result.tool ?? result.summary?.tool ?? "-"}`,
    `tool_version: ${result.tool_version ?? result.summary?.tool_version ?? "-"}`,
    `db_updated_at: ${result.db_updated_at ?? result.summary?.db?.updated_at ?? "-"}`,
    `requested_at: ${result.requested_at}`,
    `started_at: ${result.started_at ?? "-"}`,
    `completed_at: ${result.completed_at ?? "-"}`,
  ];
  if (counts) {
    lines.push(
      `severity_counts: critical=${counts.critical ?? 0} high=${counts.high ?? 0} medium=${counts.medium ?? 0} low=${counts.low ?? 0} unknown=${counts.unknown ?? 0}`,
    );
  }
  if (result.report_sha256 || result.report_bytes != null) {
    lines.push(
      `report: bytes=${result.report_bytes ?? "-"} compressed_bytes=${result.report_compressed_bytes ?? "-"} sha256=${result.report_sha256 ?? "-"}`,
    );
  }
  const findings = result.summary?.highest_findings ?? [];
  if (findings.length > 0) {
    lines.push("highest_findings:");
    for (const finding of findings) {
      lines.push(
        `  - ${finding.id} ${finding.severity} ${finding.package_name ?? "-"} ${finding.installed_version ?? "-"} -> ${finding.fixed_version ?? "-"}`,
      );
      if (finding.title) {
        lines.push(`    ${finding.title}`);
      }
    }
  }
  if (result.error) {
    lines.push(`error: ${result.error}`);
  }
  return lines.join("\n");
}

function scanCriticalCount(entry: RootfsAdminCatalogEntry): number {
  return entry.scan?.severity_counts?.critical ?? 0;
}

function scanHighCount(entry: RootfsAdminCatalogEntry): number {
  return entry.scan?.severity_counts?.high ?? 0;
}

function isScanStale(
  entry: RootfsAdminCatalogEntry,
  staleDays: number,
): boolean {
  if (!entry.scanned_at) return false;
  const scanned = Date.parse(entry.scanned_at);
  if (!Number.isFinite(scanned)) return false;
  return Date.now() - scanned > staleDays * 24 * 60 * 60 * 1000;
}

function buildRootfsScanAudit(
  entries: RootfsAdminCatalogEntry[],
  staleDays: number,
) {
  const official = entries.filter((entry) => entry.official && !entry.deleted);
  return {
    checked_at: new Date().toISOString(),
    stale_days: staleDays,
    totals: {
      official: official.length,
      unscanned: official.filter(
        (entry) => !entry.scan_status || entry.scan_status === "unknown",
      ).length,
      stale: official.filter((entry) => isScanStale(entry, staleDays)).length,
      failed: official.filter((entry) => entry.scan_status === "error").length,
      findings: official.filter((entry) => entry.scan_status === "findings")
        .length,
      critical: official.filter((entry) => scanCriticalCount(entry) > 0).length,
      high: official.filter((entry) => scanHighCount(entry) > 0).length,
    },
    unscanned: official.filter(
      (entry) => !entry.scan_status || entry.scan_status === "unknown",
    ),
    stale: official.filter((entry) => isScanStale(entry, staleDays)),
    failed: official.filter((entry) => entry.scan_status === "error"),
    findings: official.filter((entry) => entry.scan_status === "findings"),
    critical: official.filter((entry) => scanCriticalCount(entry) > 0),
  };
}

function formatRootfsScanAuditHuman(
  audit: ReturnType<typeof buildRootfsScanAudit>,
): string {
  const lines = [
    `checked_at: ${audit.checked_at}`,
    `official_images: ${audit.totals.official}`,
    `unscanned: ${audit.totals.unscanned}`,
    `stale: ${audit.totals.stale} (>${audit.stale_days} days)`,
    `failed: ${audit.totals.failed}`,
    `findings: ${audit.totals.findings}`,
    `critical: ${audit.totals.critical}`,
    `high: ${audit.totals.high}`,
  ];
  for (const [label, entries] of [
    ["critical", audit.critical],
    ["failed", audit.failed],
    ["unscanned", audit.unscanned],
    ["stale", audit.stale],
  ] as const) {
    if (!entries.length) continue;
    lines.push("", `${label}:`);
    for (const entry of entries) {
      lines.push(
        `  - ${entry.label} image_id=${entry.id} release_id=${entry.release_id ?? "-"} scan=${entry.scan_status ?? "unknown"} scanned_at=${entry.scanned_at ?? "-"}`,
      );
    }
  }
  return lines.join("\n");
}

async function loadAdminRootfsEntryById(ctx: any, image_id: string) {
  const trimmed = `${image_id ?? ""}`.trim();
  if (!trimmed) {
    throw new Error("image_id must be specified");
  }
  const rows: RootfsAdminCatalogEntry[] =
    (await ctx.hub.system.getRootfsCatalogAdmin({})) ?? [];
  const entry = rows.find((row) => row.id === trimmed);
  if (!entry) {
    throw new Error(`rootfs image '${trimmed}' not found`);
  }
  return entry;
}

async function saveAdminRootfsEntry(
  ctx: any,
  entry: RootfsAdminCatalogEntry,
  patch: Partial<RootfsAdminCatalogEntry>,
) {
  return await ctx.hub.system.saveRootfsCatalogEntry({
    image_id: entry.id,
    image: entry.image,
    label: entry.label,
    description: entry.description,
    visibility: entry.visibility,
    arch: entry.arch,
    gpu: entry.gpu,
    size_gb: entry.size_gb,
    tags: entry.tags,
    theme: entry.theme,
    official: patch.official ?? entry.official,
    prepull: patch.prepull ?? entry.prepull,
    hidden: patch.hidden ?? entry.hidden,
    blocked: patch.blocked ?? entry.blocked,
    blocked_reason:
      patch.blocked === false
        ? undefined
        : (patch.blocked_reason ??
          entry.blocked_reason ??
          (patch.blocked ? "Blocked by admin" : undefined)),
  });
}

export function registerRootfsCommand(
  program: Command,
  deps: RootfsCommandDeps,
): Command {
  const {
    withContext,
    resolveProjectFromArgOrContext,
    resolveProjectProjectApi,
    waitForLro,
    serializeLroSummary,
  } = deps;
  const rootfs = program
    .command("rootfs")
    .description("managed RootFS catalog and publish operations");

  const recipe = rootfs
    .command("recipe")
    .description("build RootFS images from recipes or local recipe modules");

  recipe
    .command("ls")
    .alias("list")
    .description("list bundled RootFS recipe examples and local modules")
    .option("--module-dir <path>", "local recipe module registry directory")
    .action((opts: { moduleDir?: string }, command: Command) => {
      const globals = command.optsWithGlobals?.() ?? {};
      const result = listRootfsRecipes(opts.moduleDir);
      if (globals.json || globals.output === "json") {
        emitSuccess({ globals }, "rootfs recipe ls", result);
      } else if (!globals.quiet) {
        console.log(formatRootfsRecipeListHuman(result));
      }
    });

  recipe
    .command("explain <recipe>")
    .description(
      "show resolved RootFS recipe steps and module inputs; <recipe> may be a file path, bundled example name, or module name",
    )
    .option("--module-dir <path>", "local recipe module registry directory")
    .action(
      async (
        recipePath: string,
        opts: { moduleDir?: string },
        command: Command,
      ) => {
        await withContext(command, "rootfs recipe explain", async () =>
          explainRootfsRecipe(recipePath, opts.moduleDir),
        );
      },
    );

  recipe
    .command("run <recipe>")
    .description(
      "run a RootFS recipe file, bundled example, or module in a clean builder project or existing project",
    )
    .option("-w, --project <project>", "existing project id or name to use")
    .option(
      "--here",
      "run in the current CoCalc project using local subprocesses; requires COCALC_PROJECT_ID",
    )
    .option("--module-dir <path>", "local recipe module registry directory")
    .option("--title <title>", "title for a new builder project")
    .option("--publish", "publish the resulting project RootFS after running")
    .option(
      "--switch-project",
      "switch the builder project to the published image",
    )
    .option("--wait", "wait for publish completion")
    .option("--browser-id <id>", "browser session id for fresh-auth checks")
    .option("--config-out <path>", "write generated RootFS config JSON")
    .option(
      "--dry-run",
      "print a runnable shell script showing the expanded recipe commands without creating or mutating a project",
    )
    .option(
      "--step-timeout <seconds>",
      "default timeout for each recipe step command",
      "900",
    )
    .action(
      async (
        recipePath: string,
        opts: RootfsRecipeRunOptions,
        command: Command,
      ) => {
        if (opts.dryRun) {
          const globals = command.optsWithGlobals?.() ?? {};
          const script = renderRootfsRecipeDryRunScript(recipePath, opts);
          if (globals.json || globals.output === "json") {
            emitSuccess({ globals }, "rootfs recipe run --dry-run", {
              recipe: recipePath,
              script,
            });
          } else if (!globals.quiet) {
            console.log(script);
          }
          return;
        }
        await withContext(command, "rootfs recipe run", async (ctx) => {
          const result = await runRootfsRecipe({
            ctx,
            deps: {
              resolveProjectFromArgOrContext,
              resolveProjectProjectApi,
              waitForLro,
              serializeLroSummary,
            },
            options: opts,
            recipePath,
          });
          if (opts.configOut) {
            writeFileSync(
              opts.configOut,
              `${JSON.stringify(result.config, null, 2)}\n`,
            );
          }
          if (ctx.globals?.json || ctx.globals?.output === "json") {
            return result;
          }
          return formatRootfsRecipeRunHuman(result);
        });
      },
    );

  recipe
    .command("verify <recipe>")
    .description(
      "run the top-level verification commands for a RootFS recipe file or bundled example",
    )
    .requiredOption("-w, --project <project>", "project id or name to verify")
    .option("--module-dir <path>", "local recipe module registry directory")
    .option(
      "--step-timeout <seconds>",
      "default timeout for each recipe verification command",
      "900",
    )
    .action(
      async (
        recipePath: string,
        opts: RootfsRecipeRunOptions,
        command: Command,
      ) => {
        await withContext(command, "rootfs recipe verify", async (ctx) => {
          const result = await runRootfsRecipe({
            ctx,
            deps: {
              resolveProjectFromArgOrContext,
              resolveProjectProjectApi,
              waitForLro,
              serializeLroSummary,
            },
            options: {
              ...opts,
              project: opts.project,
              publish: false,
              verifyOnly: true,
            },
            recipePath,
          });
          if (ctx.globals?.json || ctx.globals?.output === "json") {
            return result;
          }
          return formatRootfsRecipeRunHuman(result);
        });
      },
    );

  rootfs
    .command("build <recipe>")
    .description(
      "build a RootFS recipe in a clean builder project or existing project and save publish defaults on the project",
    )
    .option("-w, --project <project>", "existing project id or name to use")
    .option(
      "--here",
      "build in the current CoCalc project using local subprocesses; requires COCALC_PROJECT_ID",
    )
    .option("--module-dir <path>", "local recipe module registry directory")
    .option(
      "--title <title>",
      "title for a new builder project; defaults to the recipe name",
    )
    .option("--browser-id <id>", "browser session id for fresh-auth checks")
    .option("--config-out <path>", "also write generated RootFS config JSON")
    .option(
      "--detach",
      "start the durable build and return without following logs",
    )
    .option(
      "--step-timeout <seconds>",
      "default timeout for each recipe step command",
      "900",
    )
    .action(
      async (
        recipePath: string,
        opts: RootfsRecipeRunOptions,
        command: Command,
      ) => {
        await withContext(command, "rootfs build", async (ctx) => {
          const deps = {
            withContext,
            resolveProjectFromArgOrContext,
            resolveProjectProjectApi,
            waitForLro,
            serializeLroSummary,
          };
          if (opts.here) {
            const result = await runRootfsRecipe({
              ctx,
              deps,
              options: {
                ...opts,
                publish: false,
                wait: false,
              },
              recipePath,
            });
            const publishConfig = projectRootfsPublishConfigEnvelope(result);
            await ctx.hub.projects.setProjectRootfsPublishConfig({
              project_id: result.project_id,
              config: publishConfig,
            });
            if (opts.configOut) {
              writeFileSync(
                opts.configOut,
                `${JSON.stringify(result.config, null, 2)}\n`,
              );
            }
            if (ctx.globals?.json || ctx.globals?.output === "json") {
              return {
                ...result,
                saved_rootfs_publish_config: true,
              };
            }
            return [
              formatRootfsRecipeRunHuman(result),
              "",
              "saved_rootfs_publish_config: true",
              `next: cocalc rootfs publish --project=${result.project_id}`,
            ].join("\n");
          }
          const plan = resolveRootfsRecipeBuildPlan(recipePath, opts);
          const project = await startRootfsBuilderProject({
            ctx,
            deps,
            options: opts,
            plan,
          });
          const publishConfig = projectRootfsPublishConfigEnvelope(plan);
          await ctx.hub.projects.setProjectRootfsPublishConfig({
            project_id: project.project_id,
            config: publishConfig,
          });
          const build = await ctx.hub.projects.startProjectRootfsBuild({
            project_id: project.project_id,
            script: plan.script,
            recipe_ref: plan.recipe,
            resolved_recipe_json: plan.resolved_recipe,
            metadata_json: plan.config,
          });
          if (opts.configOut) {
            writeFileSync(
              opts.configOut,
              `${JSON.stringify(plan.config, null, 2)}\n`,
            );
          }
          const finalBuild = opts.detach
            ? build
            : await followRootfsBuildLog({
                ctx,
                deps,
                project_id: project.project_id,
                build_id: build.build_id,
              });
          writeLastRootfsBuild({
            ctx,
            project_id: project.project_id,
            build: finalBuild,
            recipe: plan.recipe,
          });
          const result = {
            recipe: plan.recipe,
            recipe_path: plan.recipe_path,
            project_id: project.project_id,
            created_project: project.created_project,
            build: finalBuild,
            config: plan.config,
            saved_rootfs_publish_config: true,
          };
          if (ctx.globals?.json || ctx.globals?.output === "json") {
            return result;
          }
          return formatRootfsBuildStartHuman(result);
        });
      },
    );

  rootfs
    .command("build-status [build]")
    .description("show durable RootFS build status for a project")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (
        build_id: string | undefined,
        opts: { project?: string },
        command: Command,
      ) => {
        await withContext(command, "rootfs build-status", async (ctx) => {
          const resolvedBuildId = resolveLastRootfsBuildId(ctx, build_id);
          const project = await resolveRootfsBuildProject({
            ctx,
            resolveProjectFromArgOrContext,
            project: opts.project,
          });
          const status = await ctx.hub.projects.getProjectRootfsBuildStatus({
            project_id: project.project_id,
            build_id: resolvedBuildId,
          });
          if (ctx.globals?.json || ctx.globals?.output === "json") {
            return status;
          }
          return formatRootfsBuildStatusHuman(status);
        });
      },
    );

  rootfs
    .command("build-logs [build]")
    .description("show or follow durable RootFS build logs for a project")
    .option("-w, --project <project>", "project id or name")
    .option("--tail <lines>", "line count to show before following", "100")
    .option("--follow", "continue following new log output")
    .action(
      async (
        build_id: string | undefined,
        opts: { project?: string; tail?: string; follow?: boolean },
        command: Command,
      ) => {
        await withContext(command, "rootfs build-logs", async (ctx) => {
          const resolvedBuildId = resolveLastRootfsBuildId(ctx, build_id);
          const project = await resolveRootfsBuildProject({
            ctx,
            resolveProjectFromArgOrContext,
            project: opts.project,
          });
          const { api } = await resolveProjectProjectApi(
            ctx,
            project.project_id,
          );
          const log = await readRootfsBuildLogDirect({
            api,
            ctx,
            project_id: project.project_id,
            build_id: resolvedBuildId,
            lines: parseLimit(opts.tail, 100),
          });
          if (ctx.globals?.json || ctx.globals?.output === "json") {
            return log;
          }
          if (log.text && !ctx.globals?.quiet) {
            process.stderr.write(log.text);
            if (!log.text.endsWith("\n")) {
              process.stderr.write("\n");
            }
          }
          if (opts.follow) {
            const finalStatus = await followRootfsBuildLog({
              ctx,
              deps: {
                withContext,
                resolveProjectFromArgOrContext,
                resolveProjectProjectApi,
                waitForLro,
                serializeLroSummary,
              },
              project_id: project.project_id,
              build_id: resolvedBuildId,
              byte_offset: log.next_byte_offset,
            });
            return formatRootfsBuildStatusHuman(finalStatus);
          }
          return "";
        });
      },
    );

  rootfs
    .command("build-list")
    .description("list durable RootFS builds recorded in a project")
    .option("-w, --project <project>", "project id or name")
    .option("--limit <n>", "max rows", "50")
    .action(
      async (opts: { project?: string; limit?: string }, command: Command) => {
        await withContext(command, "rootfs build-list", async (ctx) => {
          const project = await resolveRootfsBuildProject({
            ctx,
            resolveProjectFromArgOrContext,
            project: opts.project,
          });
          const { api } = await resolveProjectProjectApi(
            ctx,
            project.project_id,
          );
          const builds = await api.system.listRootfsBuilds({
            limit: parseLimit(opts.limit, 50),
          });
          if (ctx.globals?.json || ctx.globals?.output === "json") {
            return { project_id: project.project_id, builds };
          }
          return formatRootfsBuildListHuman({
            project_id: project.project_id,
            builds,
          });
        });
      },
    );

  rootfs
    .command("build-events [build]")
    .description("show or follow durable RootFS build lifecycle events")
    .option("-w, --project <project>", "project id or name")
    .option("--tail <lines>", "line count to show before following", "100")
    .option("--follow", "continue following new events")
    .action(
      async (
        build_id: string | undefined,
        opts: { project?: string; tail?: string; follow?: boolean },
        command: Command,
      ) => {
        await withContext(command, "rootfs build-events", async (ctx) => {
          const resolvedBuildId = resolveLastRootfsBuildId(ctx, build_id);
          const project = await resolveRootfsBuildProject({
            ctx,
            resolveProjectFromArgOrContext,
            project: opts.project,
          });
          const { api } = await resolveProjectProjectApi(
            ctx,
            project.project_id,
          );
          const events = await readRootfsBuildEventsDirect({
            api,
            build_id: resolvedBuildId,
            lines: parseLimit(opts.tail, 100),
          });
          if (ctx.globals?.json || ctx.globals?.output === "json") {
            return {
              ...events,
              events: parseNdjson(events.text ?? ""),
            };
          }
          if (events.text && !ctx.globals?.quiet) {
            process.stderr.write(events.text);
            if (!events.text.endsWith("\n")) {
              process.stderr.write("\n");
            }
          }
          if (opts.follow) {
            const finalStatus = await followRootfsBuildEvents({
              ctx,
              deps: {
                withContext,
                resolveProjectFromArgOrContext,
                resolveProjectProjectApi,
                waitForLro,
                serializeLroSummary,
              },
              project_id: project.project_id,
              build_id: resolvedBuildId,
              byte_offset: events.next_byte_offset,
            });
            return formatRootfsBuildStatusHuman(finalStatus);
          }
          return "";
        });
      },
    );

  rootfs
    .command("build-attach [build]")
    .description("show status, tail logs, and follow a durable RootFS build")
    .option("-w, --project <project>", "project id or name")
    .option("--tail <lines>", "line count to show before following", "100")
    .action(
      async (
        build_id: string | undefined,
        opts: { project?: string; tail?: string },
        command: Command,
      ) => {
        await withContext(command, "rootfs build-attach", async (ctx) => {
          const resolvedBuildId = resolveLastRootfsBuildId(ctx, build_id);
          const project = await resolveRootfsBuildProject({
            ctx,
            resolveProjectFromArgOrContext,
            project: opts.project,
          });
          const status = await ctx.hub.projects.getProjectRootfsBuildStatus({
            project_id: project.project_id,
            build_id: resolvedBuildId,
          });
          const { api } = await resolveProjectProjectApi(
            ctx,
            project.project_id,
          );
          const log = await readRootfsBuildLogDirect({
            api,
            ctx,
            project_id: project.project_id,
            build_id: resolvedBuildId,
            lines: parseLimit(opts.tail, 100),
          });
          if (ctx.globals?.json || ctx.globals?.output === "json") {
            return { status, log };
          }
          if (!ctx.globals?.quiet) {
            process.stderr.write(formatRootfsBuildStatusHuman(status));
            process.stderr.write("\n\n");
            if (log.text) {
              process.stderr.write(log.text);
              if (!log.text.endsWith("\n")) {
                process.stderr.write("\n");
              }
            }
          }
          const finalStatus = await followRootfsBuildLog({
            ctx,
            deps: {
              withContext,
              resolveProjectFromArgOrContext,
              resolveProjectProjectApi,
              waitForLro,
              serializeLroSummary,
            },
            project_id: project.project_id,
            build_id: resolvedBuildId,
            byte_offset: log.next_byte_offset,
          });
          return formatRootfsBuildStatusHuman(finalStatus);
        });
      },
    );

  rootfs
    .command("build-cancel [build]")
    .description("cancel a durable RootFS build for a project")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (
        build_id: string | undefined,
        opts: { project?: string },
        command: Command,
      ) => {
        await withContext(command, "rootfs build-cancel", async (ctx) => {
          const resolvedBuildId = resolveLastRootfsBuildId(ctx, build_id);
          const project = await resolveRootfsBuildProject({
            ctx,
            resolveProjectFromArgOrContext,
            project: opts.project,
          });
          const result = await ctx.hub.projects.cancelProjectRootfsBuild({
            project_id: project.project_id,
            build_id: resolvedBuildId,
          });
          if (ctx.globals?.json || ctx.globals?.output === "json") {
            return result;
          }
          return [
            `build_id: ${result.build_id}`,
            `project_id: ${result.project_id}`,
            `status: ${result.status}`,
            `signaled: ${result.signaled}`,
            ...(result.message ? [`message: ${result.message}`] : []),
          ].join("\n");
        });
      },
    );

  rootfs
    .command("list")
    .description("list visible RootFS catalog entries")
    .option(
      "--section <section>",
      "filter by section: official, mine, collaborators, public",
    )
    .option("--image <image>", "filter by runtime image name")
    .option("--label <label>", "filter by label substring")
    .option("--limit <n>", "max rows", "100")
    .action(
      async (
        opts: {
          section?: string;
          image?: string;
          label?: string;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs list", async (ctx) => {
          const section = normalizeSection(opts.section);
          const imageFilter = `${opts.image ?? ""}`.trim().toLowerCase();
          const labelFilter = `${opts.label ?? ""}`.trim().toLowerCase();
          let images = (await ctx.hub.system.getRootfsCatalog({})).images ?? [];
          if (section) {
            images = images.filter((entry) => entry.section === section);
          }
          if (imageFilter) {
            images = images.filter((entry) =>
              `${entry.image ?? ""}`.trim().toLowerCase().includes(imageFilter),
            );
          }
          if (labelFilter) {
            images = images.filter((entry) =>
              `${entry.label ?? ""}`.trim().toLowerCase().includes(labelFilter),
            );
          }
          const rows = images
            .slice(0, parseLimit(opts.limit))
            .map(serializeRootfsImageEntry);
          if (ctx.globals.json || ctx.globals.output === "json") {
            return rows;
          }
          return formatRootfsEntriesHuman(rows);
        });
      },
    );

  rootfs
    .command("admin-list")
    .description("list all RootFS catalog entries with admin lifecycle details")
    .option("--image <image>", "filter by runtime image name")
    .option("--label <label>", "filter by label substring")
    .option("--include-deleted", "include deleted rows in output")
    .option("--limit <n>", "max rows", "100")
    .action(
      async (
        opts: {
          image?: string;
          label?: string;
          includeDeleted?: boolean;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs admin-list", async (ctx) => {
          const imageFilter = `${opts.image ?? ""}`.trim().toLowerCase();
          const labelFilter = `${opts.label ?? ""}`.trim().toLowerCase();
          let rows: RootfsAdminCatalogEntry[] =
            (await ctx.hub.system.getRootfsCatalogAdmin({})) ?? [];
          if (!opts.includeDeleted) {
            rows = rows.filter((entry) => !entry.deleted);
          }
          if (imageFilter) {
            rows = rows.filter((entry) =>
              `${entry.image ?? ""}`.trim().toLowerCase().includes(imageFilter),
            );
          }
          if (labelFilter) {
            rows = rows.filter((entry) =>
              `${entry.label ?? ""}`.trim().toLowerCase().includes(labelFilter),
            );
          }
          const serialized = rows
            .slice(0, parseLimit(opts.limit))
            .map(serializeRootfsAdminEntry);
          if (ctx.globals.json || ctx.globals.output === "json") {
            return serialized;
          }
          return formatRootfsAdminEntriesHuman(serialized);
        });
      },
    );

  rootfs
    .command("shards")
    .description("list sharded RootFS rustic repositories (admin only)")
    .option("--region <region>", "filter by RootFS/R2 region")
    .option(
      "--status <status>",
      "filter by status: active, sealed, draining, disabled",
    )
    .option("--legacy", "show only legacy single-repo summary")
    .option("--hide-empty", "hide shards with no assigned DB artifacts")
    .option(
      "--r2-audit",
      "enrich shards with R2 object counts and bytes from bucket audit cache",
    )
    .option("--refresh", "force a fresh R2 audit when used with --r2-audit")
    .option(
      "--max-age-minutes <n>",
      "maximum cached R2 audit age when used with --r2-audit",
      "60",
    )
    .action(
      async (
        opts: {
          region?: string;
          status?: string;
          legacy?: boolean;
          hideEmpty?: boolean;
          r2Audit?: boolean;
          refresh?: boolean;
          maxAgeMinutes?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs shards", async (ctx) => {
          let result: RootfsRusticRepoListResult =
            await ctx.hub.system.getRootfsRusticReposAdmin({
              region: opts.region,
              status: opts.status,
            });
          if (opts.r2Audit) {
            result = await enrichRootfsRusticReposWithR2Audit({
              ctx,
              result,
              refresh: opts.refresh,
              maxAgeMinutes: parseLimit(opts.maxAgeMinutes, 60),
            });
          }
          if (opts.legacy) {
            result = { ...result, repos: [] };
          } else if (opts.hideEmpty) {
            result = {
              ...result,
              repos: result.repos.filter(
                (repo) => repo.assigned_artifact_count > 0,
              ),
            };
          }
          if (ctx.globals.json || ctx.globals.output === "json") {
            return result;
          }
          return formatRootfsRusticReposHuman(result);
        });
      },
    );

  rootfs
    .command("prepull [host_id]")
    .description(
      "queue RootFS pre-pull reconciliation for all running hosts or one host",
    )
    .option("--limit <n>", "maximum running hosts to queue", "5000")
    .action(
      async (
        hostId: string | undefined,
        opts: { limit?: string },
        command: Command,
      ) => {
        await withContext(command, "rootfs prepull", async (ctx) => {
          return await ctx.hub.system.enqueueRootfsPrepull({
            host_id: `${hostId ?? ""}`.trim() || undefined,
            limit: hostId ? undefined : parseLimit(opts.limit, 5000),
          });
        });
      },
    );

  rootfs
    .command("delete")
    .description("soft-delete a RootFS catalog entry and request safe GC")
    .requiredOption("--image-id <id>", "catalog image id")
    .option(
      "--reason <text>",
      "optional reason recorded with the delete request",
    )
    .action(
      async (
        opts: {
          imageId: string;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs delete", async (ctx) => {
          const result = await ctx.hub.system.requestRootfsImageDeletion({
            image_id: `${opts.imageId ?? ""}`.trim(),
            reason: opts.reason,
          });
          if (ctx.globals.json || ctx.globals.output === "json") {
            return result;
          }
          return formatRootfsDeleteResultHuman(result);
        });
      },
    );

  rootfs
    .command("hide")
    .description("hide a RootFS catalog entry from normal views")
    .requiredOption("--image-id <id>", "catalog image id")
    .action(
      async (
        opts: {
          imageId: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs hide", async (ctx) => {
          const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
          const result = await saveAdminRootfsEntry(ctx, entry, {
            hidden: true,
          });
          return serializeRootfsImageEntry(result);
        });
      },
    );

  rootfs
    .command("unhide")
    .description("make a hidden RootFS catalog entry visible again")
    .requiredOption("--image-id <id>", "catalog image id")
    .action(
      async (
        opts: {
          imageId: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs unhide", async (ctx) => {
          const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
          const result = await saveAdminRootfsEntry(ctx, entry, {
            hidden: false,
          });
          return serializeRootfsImageEntry(result);
        });
      },
    );

  rootfs
    .command("block")
    .description("block new use of a RootFS catalog entry")
    .requiredOption("--image-id <id>", "catalog image id")
    .option("--reason <text>", "optional block reason")
    .action(
      async (
        opts: {
          imageId: string;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs block", async (ctx) => {
          const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
          const result = await saveAdminRootfsEntry(ctx, entry, {
            blocked: true,
            blocked_reason: opts.reason,
          });
          return serializeRootfsImageEntry(result);
        });
      },
    );

  rootfs
    .command("unblock")
    .description("remove the block from a RootFS catalog entry")
    .requiredOption("--image-id <id>", "catalog image id")
    .action(
      async (
        opts: {
          imageId: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs unblock", async (ctx) => {
          const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
          const result = await saveAdminRootfsEntry(ctx, entry, {
            blocked: false,
            blocked_reason: undefined,
          });
          return serializeRootfsImageEntry(result);
        });
      },
    );

  rootfs
    .command("gc")
    .description("garbage collect pending-delete RootFS releases (admin only)")
    .option("--limit <n>", "max pending releases to scan", "10")
    .action(
      async (
        opts: {
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs gc", async (ctx) => {
          const result = await ctx.hub.system.runRootfsReleaseGc({
            limit: parseLimit(opts.limit, 10),
          });
          if (ctx.globals.json || ctx.globals.output === "json") {
            return result;
          }
          return formatRootfsGcResultHuman(result);
        });
      },
    );

  rootfs
    .command("scan")
    .description("run an admin Trivy scan for a managed RootFS release")
    .option("--image-id <id>", "catalog image id to scan")
    .option("--release-id <id>", "release id to scan")
    .requiredOption(
      "--host-id <id>",
      "project host that should materialize and scan the RootFS",
    )
    .option(
      "--scanner-image <image>",
      "pinned Trivy scanner container image; defaults to server settings/env",
    )
    .option(
      "--trivy-cache-dir <path>",
      "host-local Trivy DB/cache directory; defaults to server settings/env",
    )
    .option("--timeout-ms <n>", "scan timeout in milliseconds")
    .option("--max-target-bytes <n>", "maximum RootFS target bytes")
    .option("--max-report-bytes <n>", "maximum raw Trivy JSON report bytes")
    .option("--memory-limit <value>", "podman memory limit, e.g. 4g")
    .option("--cpu-limit <value>", "podman CPU limit, e.g. 2")
    .option("--tmpfs-size <value>", "scanner /tmp tmpfs size, e.g. 512m")
    .action(
      async (
        opts: {
          imageId?: string;
          releaseId?: string;
          hostId: string;
          scannerImage?: string;
          trivyCacheDir?: string;
          timeoutMs?: string;
          maxTargetBytes?: string;
          maxReportBytes?: string;
          memoryLimit?: string;
          cpuLimit?: string;
          tmpfsSize?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs scan", async (ctx) => {
          let release_id = `${opts.releaseId ?? ""}`.trim();
          if (!release_id && opts.imageId) {
            const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
            release_id = `${entry.release_id ?? ""}`.trim();
            if (!release_id) {
              throw new Error(
                `rootfs image '${opts.imageId}' does not reference a managed release`,
              );
            }
          }
          if (!release_id) {
            throw new Error("specify --release-id or --image-id");
          }
          const result = await ctx.hub.system.scanRootfsRelease({
            release_id,
            host_id: `${opts.hostId ?? ""}`.trim(),
            scanner_image: opts.scannerImage,
            trivy_cache_dir: opts.trivyCacheDir,
            timeout_ms: opts.timeoutMs ? Number(opts.timeoutMs) : undefined,
            max_target_bytes: opts.maxTargetBytes
              ? Number(opts.maxTargetBytes)
              : undefined,
            max_report_bytes: opts.maxReportBytes
              ? Number(opts.maxReportBytes)
              : undefined,
            memory_limit: opts.memoryLimit,
            cpu_limit: opts.cpuLimit,
            tmpfs_size: opts.tmpfsSize,
          });
          if (ctx.globals.json || ctx.globals.output === "json") {
            return result;
          }
          return formatRootfsScanResultHuman(result);
        });
      },
    );

  rootfs
    .command("scan-report")
    .description("download a retained admin RootFS scan JSON report")
    .requiredOption("--report-id <id>", "scan report artifact id")
    .action(
      async (
        opts: {
          reportId: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs scan-report", async (ctx) => {
          const report = await ctx.hub.system.getRootfsScanReport({
            report_id: `${opts.reportId ?? ""}`.trim(),
          });
          if (ctx.globals.json || ctx.globals.output === "json") {
            return report;
          }
          return JSON.stringify(report.report_json, null, 2);
        });
      },
    );

  rootfs
    .command("scan-audit")
    .description("summarize official RootFS vulnerability scan coverage")
    .option("--stale-days <n>", "scan age considered stale", "30")
    .action(
      async (
        opts: {
          staleDays?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs scan-audit", async (ctx) => {
          const entries: RootfsAdminCatalogEntry[] =
            (await ctx.hub.system.getRootfsCatalogAdmin({})) ?? [];
          const audit = buildRootfsScanAudit(
            entries,
            parseLimit(opts.staleDays, 30),
          );
          if (ctx.globals.json || ctx.globals.output === "json") {
            return audit;
          }
          return formatRootfsScanAuditHuman(audit);
        });
      },
    );

  rootfs
    .command("save")
    .description("create or update a RootFS catalog entry")
    .requiredOption("--image <image>", "runtime image reference")
    .option("--label <label>", "catalog label")
    .option("--slug <slug>", "public landing page slug")
    .option("--image-id <id>", "update an existing catalog entry by id")
    .option("--browser-id <id>", "browser session id for fresh-auth checks")
    .option(
      "--config-file <path>",
      "portable RootFS config JSON exported from the UI or authored by an agent",
    )
    .option("--family <family>", "optional image family for upgrade grouping")
    .option("--image-version <version>", "optional user-facing image version")
    .option("--channel <channel>", "optional release channel, e.g. stable")
    .option(
      "--supersedes-image-id <id>",
      "optional catalog image id superseded by this entry",
    )
    .option("--description <text>", "catalog description")
    .option("--visibility <visibility>", "private, collaborators, or public")
    .option("--tags <csv>", "comma-separated tags")
    .option("--theme-json <json>", "theme metadata as a JSON object")
    .option(
      "--arch <arch>",
      "image architecture metadata: amd64, arm64, or any",
    )
    .option("--gpu", "mark the image as requiring GPU support")
    .option("--size-gb <n>", "image size metadata in decimal GB")
    .option("--official", "mark as official (admin only)")
    .option("--prepull", "mark for automatic prepull on new hosts (admin only)")
    .option("--hidden", "hide from normal catalog views")
    .action(
      async (
        opts: {
          image: string;
          label?: string;
          slug?: string;
          imageId?: string;
          browserId?: string;
          configFile?: string;
          family?: string;
          imageVersion?: string;
          channel?: string;
          supersedesImageId?: string;
          description?: string;
          visibility?: string;
          tags?: string;
          themeJson?: string;
          arch?: string;
          gpu?: boolean;
          sizeGb?: string;
          official?: boolean;
          prepull?: boolean;
          hidden?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs save", async (ctx) => {
          const config = parseRootfsConfigFile(opts.configFile);
          const payload = rootfsCatalogConfigPayload(opts, config);
          const entry = await ctx.hub.system.saveRootfsCatalogEntry({
            image_id: `${opts.imageId ?? ""}`.trim() || undefined,
            image: opts.image,
            browser_id: `${opts.browserId ?? ""}`.trim() || undefined,
            ...payload,
            official: opts.official ? true : undefined,
            prepull: opts.prepull ? true : undefined,
            hidden: opts.hidden ? true : undefined,
          });
          return serializeRootfsImageEntry(entry);
        });
      },
    );

  rootfs
    .command("publish")
    .description("publish the current RootFS state of a project")
    .option("-w, --project <project>", "project id or name")
    .option("--label <label>", "catalog label for the published image")
    .option("--slug <slug>", "public landing page slug")
    .option("--browser-id <id>", "browser session id for fresh-auth checks")
    .option(
      "--config-file <path>",
      "portable RootFS config JSON exported from the UI or authored by an agent",
    )
    .option("--family <family>", "optional image family for upgrade grouping")
    .option("--image-version <version>", "optional user-facing image version")
    .option("--channel <channel>", "optional release channel, e.g. stable")
    .option(
      "--supersedes-image-id <id>",
      "optional catalog image id superseded by this entry",
    )
    .option("--description <text>", "catalog description")
    .option("--visibility <visibility>", "private, collaborators, or public")
    .option("--tags <csv>", "comma-separated tags")
    .option("--theme-json <json>", "theme metadata as a JSON object")
    .option("--official", "mark as official (admin only)")
    .option("--prepull", "mark for automatic prepull on new hosts (admin only)")
    .option("--hidden", "hide from normal catalog views")
    .option(
      "--switch-project",
      "switch the project to the newly published image when publishing succeeds",
    )
    .option("--wait", "wait for the publish LRO to finish")
    .action(
      async (
        opts: {
          project?: string;
          label?: string;
          slug?: string;
          browserId?: string;
          configFile?: string;
          family?: string;
          imageVersion?: string;
          channel?: string;
          supersedesImageId?: string;
          description?: string;
          visibility?: string;
          tags?: string;
          themeJson?: string;
          official?: boolean;
          prepull?: boolean;
          hidden?: boolean;
          switchProject?: boolean;
          wait?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs publish", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const config = await rootfsPublishConfigForProject({
            ctx,
            configFile: opts.configFile,
            project_id: ws.project_id,
          });
          const payload = rootfsCatalogConfigPayload(opts, config);
          const op = await ctx.hub.system.publishProjectRootfsImage({
            project_id: ws.project_id,
            browser_id: `${opts.browserId ?? ""}`.trim() || undefined,
            ...payload,
            official: opts.official ? true : undefined,
            prepull: opts.prepull ? true : undefined,
            hidden: opts.hidden ? true : undefined,
            switch_project: opts.switchProject ? true : undefined,
          });
          if (!opts.wait) {
            return {
              project_id: ws.project_id,
              op_id: op.op_id,
              scope_type: op.scope_type,
              scope_id: op.scope_id,
              stream_name: op.stream_name,
              status: "queued",
            };
          }
          const waited = await waitForLro(ctx, op.op_id, {
            timeoutMs: ctx.timeoutMs,
            pollMs: ctx.pollMs,
          });
          if (waited.timedOut) {
            throw new Error(
              `rootfs publish timed out (op=${op.op_id}, last_status=${waited.status})`,
            );
          }
          const summary = await ctx.hub.lro.get({ op_id: op.op_id });
          if (!summary) {
            return {
              project_id: ws.project_id,
              op_id: op.op_id,
              status: waited.status,
              error: waited.error ?? null,
            };
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `rootfs publish failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }
          return serializeLroSummary(summary);
        });
      },
    );

  return rootfs;
}
