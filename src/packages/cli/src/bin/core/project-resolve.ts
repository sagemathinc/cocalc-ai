import type { HubApi } from "@cocalc/conat/hub/api";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";
import type { UserSearchResult } from "@cocalc/util/db-schema/accounts";
import { isValidUUID } from "@cocalc/util/misc";

export type ProjectLike = {
  project_id: string;
  title: string;
  host_id: string | null;
  state?: { state?: string } | null;
  last_edited?: string | Date | null;
  deleted?: string | Date | boolean | null;
  users?: Record<string, any> | null;
  users_summary?: Record<string, any> | null;
};

export type HostLike = {
  id: string;
  name: string;
};

export type ProjectCacheContext<W extends ProjectLike = ProjectLike> = {
  projectCache: Map<string, { expiresAt: number; project: W }>;
  accountId?: string;
  apiBaseUrl?: string;
  hub: Pick<HubApi, "db" | "system" | "hosts">;
};

type ProjectListReadMode = "off" | "prefer" | "only";

type AccountProjectIndexRow = {
  account_id: string;
  project_id: string;
  owning_bay_id?: string | null;
  host_id: string | null;
  title: string;
  description?: string | null;
  users_summary?: Record<string, any> | null;
  state_summary?: { state?: string } | null;
  last_edited?: string | Date | null;
  last_activity_at?: string | Date | null;
  last_opened_at?: string | Date | null;
  is_hidden?: boolean | null;
  sort_key?: string | Date | null;
  updated_at?: string | Date | null;
};

function getProjectListReadMode(): ProjectListReadMode {
  const raw =
    `${process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS ?? ""}`
      .trim()
      .toLowerCase();
  if (!raw) {
    const role = `${process.env.COCALC_CLUSTER_ROLE ?? ""}`
      .trim()
      .toLowerCase();
    if (role === "seed" || role === "attached") {
      return "prefer";
    }
    return "off";
  }
  const value = raw;
  if (
    value === "1" ||
    value === "true" ||
    value === "on" ||
    value === "prefer"
  ) {
    return "prefer";
  }
  if (value === "only" || value === "strict" || value === "required") {
    return "only";
  }
  return "off";
}

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
  return cached.project;
}

function setCachedProject<W extends ProjectLike>(
  ctx: ProjectCacheContext<W>,
  project: W,
  projectCacheTtlMs: number,
): void {
  const expiresAt = Date.now() + projectCacheTtlMs;
  ctx.projectCache.set(projectCacheKey(project.project_id), {
    project,
    expiresAt,
  });
  if (project.title) {
    ctx.projectCache.set(projectCacheKey(project.title), {
      project,
      expiresAt,
    });
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return `${err}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:.,=+@%-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isProjectBayPermissionDenied(err: unknown): boolean {
  const message = messageOf(err);
  const code = (err as { code?: unknown } | null)?.code;
  return (
    (code === 403 ||
      code === "403" ||
      message.includes("code='403'") ||
      message.includes("code=403")) &&
    message.includes("permission denied publishing") &&
    message.includes("system.getProjectBay")
  );
}

function projectBayPermissionDeniedError(
  ctx: ProjectCacheContext,
  project_id: string,
  err: unknown,
): Error {
  const api = `${ctx.apiBaseUrl ?? ""}`.trim();
  const authCommand = api
    ? `cocalc --api ${shellQuote(api)} auth login --email <you@example.com>`
    : "cocalc --api <api-url> auth login --email <you@example.com>";
  const error = new Error(
    [
      `Cannot resolve project ${project_id} with these credentials.`,
      "This command needs an account-level project routing lookup before it can connect to the project host.",
      "The current API key appears to be project-scoped, so it can run project operations but cannot call the account-level routing API.",
      `Use an account API key or create a browser-authenticated CLI session with \`${authCommand}\`, complete the browser approval, then retry the same command without COCALC_API_KEY so the CLI uses that login session.`,
      `Original error: ${messageOf(err)}`,
    ].join("\n"),
  );
  (error as { code?: unknown }).code = (err as { code?: unknown } | null)?.code;
  return error;
}

async function getProjectBayWithHelpfulError<W extends ProjectLike>(
  ctx: ProjectCacheContext<W>,
  project_id: string,
) {
  try {
    return await ctx.hub.system.getProjectBay({ project_id });
  } catch (err) {
    if (isProjectBayPermissionDenied(err)) {
      throw projectBayPermissionDeniedError(ctx, project_id, err);
    }
    throw err;
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

function mapProjectedProjectRow<W extends ProjectLike>(
  row: AccountProjectIndexRow,
): W {
  const project = {
    project_id: row.project_id,
    title: row.title,
    host_id: row.host_id ?? null,
    state: row.state_summary ?? null,
    last_edited: row.last_edited ?? row.updated_at ?? null,
    deleted: false,
  };
  if (row.users_summary != null) {
    (project as ProjectLike).users_summary = row.users_summary;
  }
  return project as W;
}

async function queryProjectedProjects<W extends ProjectLike = ProjectLike>({
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
}): Promise<{ rows: W[]; matchedRowCount: number }> {
  const row: Record<string, unknown> = {
    account_id: ctx.accountId ?? null,
    project_id: null,
    host_id: null,
    title: null,
    state_summary: null,
    users_summary: null,
    last_edited: null,
    sort_key: null,
    updated_at: null,
    is_hidden: null,
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
  const rows = await userQueryTable<AccountProjectIndexRow>(
    ctx,
    "account_project_index",
    row,
    [{ limit, order_by: "-sort_key" }],
  );
  return {
    rows: rows
      .filter((x) => x.is_hidden !== true)
      .map((x) => mapProjectedProjectRow<W>(x)),
    matchedRowCount: rows.length,
  };
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
  const readMode = getProjectListReadMode();
  if (readMode !== "off") {
    try {
      const { rows: projectedRows, matchedRowCount } =
        await queryProjectedProjects<W>({
          ctx,
          project_id,
          title,
          host_id,
          limit,
        });
      if (
        readMode === "only" ||
        projectedRows.length > 0 ||
        matchedRowCount > 0
      ) {
        return projectedRows;
      }
    } catch (err) {
      if (readMode === "only") {
        throw err;
      }
    }
  }
  const row: Record<string, unknown> = {
    project_id: null,
    title: null,
    host_id: null,
    state: null,
    users: null,
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
  let rows: W[] = [];
  let localErr: unknown;
  try {
    rows = await userQueryTable<W>(ctx, "projects", row, [
      { limit, order_by: "-last_edited" },
    ]);
  } catch (err) {
    localErr = err;
  }
  const visibleRows = rows.filter((x) => !isDeleted(x.deleted));
  if (visibleRows.length || !project_id || title != null || host_id != null) {
    if (
      !visibleRows.length &&
      localErr &&
      (!project_id || title != null || host_id != null)
    ) {
      throw localErr;
    }
    return visibleRows;
  }
  if (!isValidUUID(project_id)) {
    if (localErr) {
      throw localErr;
    }
    return visibleRows;
  }
  const located = await getProjectBayWithHelpfulError(ctx, project_id);
  if (!located?.project_id) {
    if (localErr) {
      throw localErr;
    }
    return visibleRows;
  }
  return [
    {
      project_id: located.project_id,
      title: `${located.title ?? ""}`.trim() || located.project_id,
      host_id: located.host_id ?? null,
      state: null,
      last_edited: null,
      deleted: false,
    } as W,
  ];
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

  // Project-scoped agent sessions cannot use account-wide project discovery.
  // The API still authorizes the requested operation against the token scope.
  if (
    isValidUUID(identifier) &&
    identifier === process.env.COCALC_PROJECT_ID &&
    !!process.env.COCALC_AGENT_TOKEN_FILE
  ) {
    const project = {
      project_id: identifier,
      title: identifier,
      host_id: null,
      state: null,
      deleted: false,
    } as W;
    setCachedProject(ctx, project, projectCacheTtlMs);
    return project;
  }

  if (isValidUUID(identifier)) {
    let queryErr: unknown;
    let rows: W[] = [];
    try {
      rows = await queryProjects({
        ctx,
        project_id: identifier,
        limit: 3,
      });
    } catch (err) {
      queryErr = err;
    }
    if (rows[0]) {
      setCachedProject(ctx, rows[0], projectCacheTtlMs);
      return rows[0];
    }
    try {
      const located = await getProjectBayWithHelpfulError(ctx, identifier);
      if (located?.project_id) {
        const remoteProject = {
          project_id: located.project_id,
          title: `${located.title ?? ""}`.trim() || located.project_id,
          host_id: located.host_id ?? null,
          state: null,
          last_edited: null,
          deleted: false,
        } as W;
        setCachedProject(ctx, remoteProject, projectCacheTtlMs);
        return remoteProject;
      }
    } catch (err) {
      if (queryErr) throw queryErr;
      throw err;
    }
    if (queryErr) throw queryErr;
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

export async function resolveProjectFromArgOrContext<
  W extends ProjectLike = ProjectLike,
>({
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
  readProjectContext: (
    cwd?: string,
  ) => { project_id?: string; title?: string } | undefined;
  projectContextPath: (cwd?: string) => string;
}): Promise<W> {
  const value = identifier?.trim();
  if (value) {
    return await resolveProject(ctx, value, projectCacheTtlMs);
  }
  const currentDir = cwd;
  const context = readProjectContext(currentDir);
  const projectId =
    (process.env.COCALC_AGENT_TOKEN_FILE
      ? process.env.COCALC_PROJECT_ID
      : undefined) || context?.project_id;
  if (!projectId) {
    throw new Error(
      `missing --project and no project context is set at ${projectContextPath(currentDir)}; run 'cocalc project use --project <project>'`,
    );
  }
  return await resolveProject(ctx, projectId, projectCacheTtlMs);
}

export function normalizeUserSearchName(row: UserSearchResult): string {
  return displayNameFromAccount(row) || row.email_address || row.account_id;
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
    const full = displayNameFromAccount(row).toLowerCase();
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
  opts: {
    include_deleted?: boolean;
    admin_view?: boolean;
  } = {},
): Promise<H> {
  const loadHosts = async (): Promise<H[]> => {
    const base = {
      include_deleted: !!opts.include_deleted,
      catalog: !opts.include_deleted,
    };
    if (opts.admin_view) {
      try {
        return (await ctx.hub.hosts.listHosts({
          ...base,
          admin_view: true,
        })) as unknown as H[];
      } catch (err) {
        if (!/not authorized/i.test(`${err}`)) {
          throw err;
        }
      }
    }
    return (await ctx.hub.hosts.listHosts(base)) as unknown as H[];
  };

  if (isValidUUID(identifier)) {
    try {
      const hosts = await loadHosts();
      if (Array.isArray(hosts)) {
        const match = hosts.find((x) => x.id === identifier);
        if (match) {
          return match;
        }
      }
    } catch {}
    return {
      id: identifier,
      name: identifier,
    } as H;
  }

  const hosts = await loadHosts();
  if (!Array.isArray(hosts) || !hosts.length) {
    throw new Error("no hosts are visible to this account");
  }

  const matches = hosts.filter((x) => x.name === identifier);
  if (!matches.length) {
    throw new Error(`host '${identifier}' not found`);
  }
  if (matches.length > 1) {
    throw new Error(
      `host name '${identifier}' is ambiguous: ${matches.map((x) => x.id).join(", ")}`,
    );
  }
  return matches[0];
}

export async function listHosts<H extends HostLike = HostLike>(
  ctx: ProjectCacheContext,
  opts: {
    include_deleted?: boolean;
    catalog?: boolean;
    admin_view?: boolean;
  } = {},
): Promise<H[]> {
  const hosts = (await ctx.hub.hosts.listHosts({
    include_deleted: !!opts.include_deleted,
    catalog: !!opts.catalog,
    admin_view: !!opts.admin_view,
  })) as unknown as H[];
  if (!Array.isArray(hosts)) return [];
  return hosts;
}
