import type { HubApi } from "@cocalc/conat/hub/api";
import type { UserSearchResult } from "@cocalc/util/db-schema/accounts";
import { isValidUUID } from "@cocalc/util/misc";

export type WorkspaceLike = {
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

export type WorkspaceCacheContext<W extends WorkspaceLike = WorkspaceLike> = {
  workspaceCache: Map<string, { expiresAt: number; workspace: W }>;
  hub: Pick<HubApi, "db" | "system" | "hosts">;
};

function workspaceCacheKey(identifier: string): string {
  const value = identifier.trim();
  if (isValidUUID(value)) {
    return `id:${value.toLowerCase()}`;
  }
  return `title:${value}`;
}

function getCachedWorkspace<W extends WorkspaceLike>(
  ctx: WorkspaceCacheContext<W>,
  identifier: string,
): W | undefined {
  const key = workspaceCacheKey(identifier);
  const cached = ctx.workspaceCache.get(key);
  if (!cached) return undefined;
  if (Date.now() >= cached.expiresAt) {
    ctx.workspaceCache.delete(key);
    return undefined;
  }
  return cached.workspace;
}

function setCachedWorkspace<W extends WorkspaceLike>(
  ctx: WorkspaceCacheContext<W>,
  workspace: W,
  workspaceCacheTtlMs: number,
): void {
  const expiresAt = Date.now() + workspaceCacheTtlMs;
  ctx.workspaceCache.set(workspaceCacheKey(workspace.project_id), { workspace, expiresAt });
  if (workspace.title) {
    ctx.workspaceCache.set(workspaceCacheKey(workspace.title), { workspace, expiresAt });
  }
}

export function workspaceState(value: WorkspaceLike["state"]): string {
  return typeof value?.state === "string" ? value.state : "";
}

function isDeleted(value: WorkspaceLike["deleted"]): boolean {
  return value != null && value !== false;
}

export async function userQueryTable<T>(
  ctx: WorkspaceCacheContext,
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

export async function queryProjects<W extends WorkspaceLike = WorkspaceLike>({
  ctx,
  project_id,
  title,
  host_id,
  limit,
}: {
  ctx: WorkspaceCacheContext<W>;
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

export async function resolveWorkspace<W extends WorkspaceLike = WorkspaceLike>(
  ctx: WorkspaceCacheContext<W>,
  identifier: string,
  workspaceCacheTtlMs: number,
): Promise<W> {
  const cached = getCachedWorkspace(ctx, identifier);
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
      setCachedWorkspace(ctx, rows[0], workspaceCacheTtlMs);
      return rows[0];
    }
  }

  const rows = await queryProjects({
    ctx,
    title: identifier,
    limit: 25,
  });
  if (!rows.length) {
    throw new Error(`workspace '${identifier}' not found`);
  }
  if (rows.length > 1) {
    throw new Error(
      `workspace name '${identifier}' is ambiguous: ${rows.map((x) => x.project_id).join(", ")}`,
    );
  }
  setCachedWorkspace(ctx, rows[0], workspaceCacheTtlMs);
  return rows[0];
}

export async function resolveWorkspaceFromArgOrContext<W extends WorkspaceLike = WorkspaceLike>({
  ctx,
  identifier,
  cwd,
  workspaceCacheTtlMs,
  readWorkspaceContext,
  workspaceContextPath,
}: {
  ctx: WorkspaceCacheContext<W>;
  identifier?: string;
  cwd?: string;
  workspaceCacheTtlMs: number;
  readWorkspaceContext: (cwd?: string) => { workspace_id?: string; title?: string } | undefined;
  workspaceContextPath: (cwd?: string) => string;
}): Promise<W> {
  const value = identifier?.trim();
  if (value) {
    return await resolveWorkspace(ctx, value, workspaceCacheTtlMs);
  }
  const currentDir = cwd;
  const context = readWorkspaceContext(currentDir);
  if (!context?.workspace_id) {
    throw new Error(
      `missing --workspace and no workspace context is set at ${workspaceContextPath(currentDir)}; run 'cocalc ws use --workspace <workspace>'`,
    );
  }
  return await resolveWorkspace(ctx, context.workspace_id, workspaceCacheTtlMs);
}

export function normalizeUserSearchName(row: UserSearchResult): string {
  const first = `${row.first_name ?? ""}`.trim();
  const last = `${row.last_name ?? ""}`.trim();
  const full = `${first} ${last}`.trim();
  return `${row.name ?? full}`.trim() || row.account_id;
}

export async function resolveAccountByIdentifier(
  ctx: WorkspaceCacheContext,
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
  ctx: WorkspaceCacheContext,
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
  ctx: WorkspaceCacheContext,
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
