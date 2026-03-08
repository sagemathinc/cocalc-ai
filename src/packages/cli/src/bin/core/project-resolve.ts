import type { HubApi } from "@cocalc/conat/hub/api";
import type { UserSearchResult } from "@cocalc/util/db-schema/accounts";
import { isValidUUID } from "@cocalc/util/misc";

export type ProjectLike = {
  project_id: string;
  title: string;
  host_id: string | null;
  state?: { state?: string } | null;
  last_edited?: string | Date | null;
  deleted?: string | Date | boolean | null;
};

export type HostLike = {
  id: string;
  name: string;
};

export type ProjectCacheContext<W extends ProjectLike = ProjectLike> = {
  projectCache: Map<string, { expiresAt: number; workspace: W }>;
  hub: Pick<HubApi, "db" | "system" | "hosts">;
};

function projectCacheKey(identifier: string): string {
  const value = identifier.trim();
  if (isValidUUID(value)) {
    return `id:${value.toLowerCase()}`;
  }
  return `title:${value}`;
}

function getCachedProject<W extends ProjectLike>(
  ctx: ProjectCacheContext<W>,
  identifier: string,
): W | undefined {
  const key = projectCacheKey(identifier);
  const cached = ctx.projectCache.get(key);
  if (!cached) return undefined;
  if (Date.now() >= cached.expiresAt) {
    ctx.projectCache.delete(key);
    return undefined;
  }
  return cached.workspace;
}

function setCachedProject<W extends ProjectLike>(
  ctx: ProjectCacheContext<W>,
  workspace: W,
  projectCacheTtlMs: number,
): void {
  const expiresAt = Date.now() + projectCacheTtlMs;
  ctx.projectCache.set(projectCacheKey(workspace.project_id), { workspace, expiresAt });
  if (workspace.title) {
    ctx.projectCache.set(projectCacheKey(workspace.title), { workspace, expiresAt });
  }
}

export function projectState(value: ProjectLike["state"]): string {
  return typeof value?.state === "string" ? value.state : "";
}

function isDeleted(value: ProjectLike["deleted"]): boolean {
  return value != null && value !== false;
}

export async function userQueryTable<T>(
  ctx: ProjectCacheContext,
  table: string,
  row: Record<string, unknown>,
  options: any[] = [],
): Promise<T[]> {
  const query = {
    [table]: [row],
  };
  const result = (await ctx.hub.db.userQuery({
    query,
    options,
  })) as Record<string, T[]>;
  const rows = result?.[table];
  return Array.isArray(rows) ? rows : [];
}

export async function queryProjects<W extends ProjectLike = ProjectLike>({
  ctx,
  project_id,
  title,
  host_id,
  limit,
}: {
  ctx: ProjectCacheContext<W>;
  project_id?: string;
  title?: string;
  host_id?: string | null;
  limit: number;
}): Promise<W[]> {
  const row: Record<string, unknown> = {
    project_id: null,
    title: null,
    host_id: null,
    state: null,
    last_edited: null,
    deleted: null,
  };
  if (project_id != null) {
    row.project_id = project_id;
  }
  if (title != null) {
    row.title = title;
  }
  if (host_id != null) {
    row.host_id = host_id;
  }
  const rows = await userQueryTable<W>(ctx, "projects_all", row, [
    { limit, order_by: "-last_edited" },
  ]);
  return rows.filter((x) => !isDeleted(x.deleted));
}

export async function resolveProject<W extends ProjectLike = ProjectLike>(
  ctx: ProjectCacheContext<W>,
  identifier: string,
  projectCacheTtlMs: number,
): Promise<W> {
  const cached = getCachedProject(ctx, identifier);
  if (cached) {
    return cached;
  }

  if (isValidUUID(identifier)) {
    const rows = await queryProjects({
      ctx,
      project_id: identifier,
      limit: 3,
    });
    if (rows[0]) {
      setCachedProject(ctx, rows[0], projectCacheTtlMs);
      return rows[0];
    }
  }

  const rows = await queryProjects({
    ctx,
    title: identifier,
    limit: 25,
  });
  if (!rows.length) {
    throw new Error(`project '${identifier}' not found`);
  }
  if (rows.length > 1) {
    throw new Error(
      `project name '${identifier}' is ambiguous: ${rows.map((x) => x.project_id).join(", ")}`,
    );
  }
  setCachedProject(ctx, rows[0], projectCacheTtlMs);
  return rows[0];
}

export async function resolveProjectFromArgOrContext<W extends ProjectLike = ProjectLike>({
  ctx,
  identifier,
  cwd,
  projectCacheTtlMs,
  readProjectContext,
  projectContextPath,
}: {
  ctx: ProjectCacheContext<W>;
  identifier?: string;
  cwd?: string;
  projectCacheTtlMs: number;
  readProjectContext: (cwd?: string) => { project_id?: string; title?: string } | undefined;
  projectContextPath: (cwd?: string) => string;
}): Promise<W> {
  const value = identifier?.trim();
  if (value) {
    return await resolveProject(ctx, value, projectCacheTtlMs);
  }
  const currentDir = cwd;
  const context = readProjectContext(currentDir);
  if (!context?.project_id) {
    throw new Error(
      `missing --project and no project context is set at ${projectContextPath(currentDir)}; run 'cocalc project use --project <project>'`,
    );
  }
  return await resolveProject(ctx, context.project_id, projectCacheTtlMs);
}

export function normalizeUserSearchName(row: UserSearchResult): string {
  const first = `${row.first_name ?? ""}`.trim();
  const last = `${row.last_name ?? ""}`.trim();
  const full = `${first} ${last}`.trim();
  return `${row.name ?? full}`.trim() || row.account_id;
}

export async function resolveAccountByIdentifier(
  ctx: ProjectCacheContext,
  identifier: string,
): Promise<UserSearchResult> {
  const value = `${identifier ?? ""}`.trim();
  if (!value) {
    throw new Error("user identifier must be non-empty");
  }
  if (isValidUUID(value)) {
    return {
      account_id: value,
      name: value,
    };
  }

  const queryIsEmail = value.includes("@");
  const rows = await ctx.hub.system.userSearch({
    query: value,
    limit: 50,
    ...(queryIsEmail ? { only_email: true } : undefined),
  });
  if (!rows?.length) {
    throw new Error(`user '${value}' not found`);
  }

  const lowerValue = value.toLowerCase();
  const exact = rows.filter((row) => {
    if (`${row.account_id}`.toLowerCase() === lowerValue) return true;
    if (`${row.email_address ?? ""}`.toLowerCase() === lowerValue) return true;
    if (`${row.name ?? ""}`.toLowerCase() === lowerValue) return true;
    const full = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim().toLowerCase();
    return full === lowerValue;
  });

  const candidates = exact.length ? exact : rows;
  if (candidates.length > 1) {
    const preview = candidates
      .slice(0, 8)
      .map((row) => `${normalizeUserSearchName(row)} (${row.account_id})`)
      .join(", ");
    throw new Error(`user '${value}' is ambiguous: ${preview}`);
  }
  return candidates[0];
}

export async function resolveHost<H extends HostLike = HostLike>(
  ctx: ProjectCacheContext,
  identifier: string,
): Promise<H> {
  const hosts = (await ctx.hub.hosts.listHosts({
    include_deleted: false,
    catalog: true,
  })) as unknown as H[];
  if (!Array.isArray(hosts) || !hosts.length) {
    throw new Error("no hosts are visible to this account");
  }

  if (isValidUUID(identifier)) {
    const match = hosts.find((x) => x.id === identifier);
    if (match) {
      return match;
    }
    throw new Error(`host '${identifier}' not found`);
  }

  const matches = hosts.filter((x) => x.name === identifier);
  if (!matches.length) {
    throw new Error(`host '${identifier}' not found`);
  }
  if (matches.length > 1) {
    throw new Error(`host name '${identifier}' is ambiguous: ${matches.map((x) => x.id).join(", ")}`);
  }
  return matches[0];
}

export async function listHosts<H extends HostLike = HostLike>(
  ctx: ProjectCacheContext,
  opts: { include_deleted?: boolean; catalog?: boolean; admin_view?: boolean } = {},
): Promise<H[]> {
  const hosts = (await ctx.hub.hosts.listHosts({
    include_deleted: !!opts.include_deleted,
    catalog: !!opts.catalog,
    admin_view: !!opts.admin_view,
  })) as unknown as H[];
  if (!Array.isArray(hosts)) return [];
  return hosts;
}
