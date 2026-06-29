/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { dirname, basename } from "node:path";
import { posix } from "node:path";

import { Command } from "commander";

import type {
  CopyPublicDirectoryShareToNewProjectResponse,
  CopyPublicDirectoryShareToProjectResponse,
  ListPublicDirectoryShareDirectoryResponse,
  PublicDirectoryShareDirectoryEntry,
  ResolvedPublicDirectoryShare,
} from "@cocalc/conat/hub/api/public-directory-shares";

export type ShareCommandDeps = {
  withContext: any;
  hubCallByName: any;
  resolveShareFilesystem: any;
  emitProjectFileCatHumanContent: any;
  writeFileLocal: any;
  mkdirLocal: any;
  waitForLro: any;
};

type ShareTargetOptions = {
  slug?: string;
  viaFs?: boolean;
};

type ShareCopyOptions = ShareTargetOptions & {
  project?: string;
  newProject?: boolean;
  dest?: string;
  title?: string;
  recursive?: boolean;
  wait?: boolean;
};

type ResolvedShareTarget = {
  share: ResolvedPublicDirectoryShare;
  slug: string;
  path: string;
};

function stripSharePrefix(path: string): string {
  const normalized = path.trim().replace(/^\/+/, "");
  if (normalized === "share") {
    return "";
  }
  return normalized.startsWith("share/")
    ? normalized.slice("share/".length)
    : normalized;
}

function normalizeShareTargetInput(input: string): string {
  const raw = `${input ?? ""}`.trim();
  if (!raw) {
    throw new Error("share path or URL is required");
  }
  try {
    const url = new URL(raw);
    return stripSharePrefix(decodeURIComponent(url.pathname));
  } catch {
    return stripSharePrefix(decodeURIComponent(raw.split(/[?#]/, 1)[0] ?? ""));
  }
}

function normalizeRelativePath(path: string | undefined): string {
  const raw = `${path ?? ""}`.trim().replace(/\\/g, "/");
  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  if (!trimmed || trimmed === ".") {
    return ".";
  }
  if (trimmed.includes("//")) {
    throw new Error("share path must not contain duplicate slashes");
  }
  for (const part of trimmed.split("/")) {
    if (!part || part === "." || part === "..") {
      throw new Error(
        "share path must not contain empty, '.', or '..' segments",
      );
    }
    if (/[\x00-\x1f\x7f]/.test(part)) {
      throw new Error("share path must not contain control characters");
    }
  }
  return trimmed;
}

function shareRouteCandidates(
  target: string,
): Array<{ slug: string; path: string }> {
  const normalized = normalizeShareTargetInput(target).replace(
    /^\/+|\/+$/g,
    "",
  );
  if (!normalized) {
    throw new Error("share path or URL is required");
  }
  const parts = normalized.split("/").filter(Boolean);
  const candidates: Array<{ slug: string; path: string }> = [];
  for (let i = parts.length; i >= 1; i -= 1) {
    candidates.push({
      slug: parts.slice(0, i).join("/"),
      path: normalizeRelativePath(parts.slice(i).join("/")),
    });
  }
  return candidates;
}

function isNotFoundError(err: unknown): boolean {
  return `${(err as Error)?.message ?? err ?? ""}`
    .toLowerCase()
    .includes("public directory share not found");
}

function shareProjectPath(
  share: ResolvedPublicDirectoryShare,
  path: string,
): string {
  if (path === ".") {
    return share.path;
  }
  if (share.path === ".") {
    return path;
  }
  return posix.join(share.path, path);
}

async function resolveShareTarget({
  ctx,
  deps,
  target,
  slug,
}: {
  ctx: any;
  deps: ShareCommandDeps;
  target: string;
  slug?: string;
}): Promise<ResolvedShareTarget> {
  if (slug?.trim()) {
    const share = (await deps.hubCallByName(
      ctx,
      "publicDirectoryShares.resolve",
      [{ slug: slug.trim() }],
    )) as ResolvedPublicDirectoryShare;
    return {
      share,
      slug: share.slug,
      path: normalizeRelativePath(target),
    };
  }

  let lastNotFound: unknown;
  for (const candidate of shareRouteCandidates(target)) {
    try {
      const share = (await deps.hubCallByName(
        ctx,
        "publicDirectoryShares.resolve",
        [{ slug: candidate.slug }],
      )) as ResolvedPublicDirectoryShare;
      return {
        share,
        slug: share.slug,
        path: candidate.path,
      };
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
      lastNotFound = err;
    }
  }
  throw lastNotFound ?? new Error("public directory share not found");
}

function formatDirectoryEntries(
  response: ListPublicDirectoryShareDirectoryResponse,
): Array<Record<string, unknown>> {
  return response.entries.map((entry: PublicDirectoryShareDirectoryEntry) => ({
    name: entry.name,
    path: entry.path,
    is_dir: entry.isDir === true || entry.type === "d",
    size: entry.size ?? null,
    mtime: entry.mtime ?? null,
    link_target: entry.linkTarget ?? null,
  }));
}

function formatFilesystemListingEntries({
  files,
  parentPath,
}: {
  files: Record<string, any>;
  parentPath: string;
}): Array<Record<string, unknown>> {
  return Object.entries(files).map(([name, info]) => ({
    name,
    path: parentPath === "." ? name : posix.join(parentPath, name),
    is_dir: info?.isDir === true || info?.type === "d",
    size: info?.size ?? null,
    mtime: info?.mtime ?? null,
    link_target: info?.linkTarget ?? null,
  }));
}

function defaultDownloadDestination(path: string): string {
  if (path === ".") {
    throw new Error(
      "destination is required when downloading a share directory",
    );
  }
  return basename(path) || "download";
}

function copyMode(opts: ShareCopyOptions): "project" | "new-project" {
  const project = `${opts.project ?? ""}`.trim();
  if (project && opts.newProject) {
    throw new Error("use either --project or --new-project, not both");
  }
  if (project) {
    return "project";
  }
  if (opts.newProject) {
    return "new-project";
  }
  throw new Error("one of --project or --new-project is required");
}

async function maybeWaitForCopy({
  ctx,
  deps,
  response,
  wait,
}: {
  ctx: any;
  deps: ShareCommandDeps;
  response:
    | CopyPublicDirectoryShareToProjectResponse
    | CopyPublicDirectoryShareToNewProjectResponse;
  wait?: boolean;
}) {
  if (!wait) {
    return response;
  }
  const status = await deps.waitForLro(ctx, response.op_id, {
    timeoutMs: ctx.timeoutMs,
    pollMs: ctx.pollMs,
  });
  return { ...response, final_status: status };
}

export function registerShareCommand(
  program: Command,
  deps: ShareCommandDeps,
): Command {
  const share = program
    .command("share")
    .description("browse and copy published CoCalc shares");

  share
    .command("info <share>")
    .description("show metadata for a published share path or URL")
    .option("--slug <slug>", "explicit share path slug")
    .action(
      async (target: string, opts: ShareTargetOptions, command: Command) => {
        await deps.withContext(command, "share info", async (ctx: any) => {
          const resolved = await resolveShareTarget({
            ctx,
            deps,
            target,
            slug: opts.slug,
          });
          return {
            ...resolved.share,
            requested_path: resolved.path,
            project_path: shareProjectPath(resolved.share, resolved.path),
          };
        });
      },
    );

  share
    .command("ls <share>")
    .description("list a directory inside a published share")
    .option("--slug <slug>", "explicit share path slug")
    .option(
      "--via-fs",
      "list via the share filesystem service instead of the hub listing RPC",
    )
    .action(
      async (target: string, opts: ShareTargetOptions, command: Command) => {
        await deps.withContext(command, "share ls", async (ctx: any) => {
          const resolved = await resolveShareTarget({
            ctx,
            deps,
            target,
            slug: opts.slug,
          });
          if (opts.viaFs) {
            const fs = await deps.resolveShareFilesystem(ctx, resolved.share);
            const projectPath = shareProjectPath(resolved.share, resolved.path);
            const snapshot = await fs.getListing(projectPath);
            return formatFilesystemListingEntries({
              files: snapshot.files ?? {},
              parentPath: projectPath,
            });
          }
          const response = (await deps.hubCallByName(
            ctx,
            "publicDirectoryShares.listDirectory",
            [{ slug: resolved.slug, path: resolved.path }],
          )) as ListPublicDirectoryShareDirectoryResponse;
          return formatDirectoryEntries(response);
        });
      },
    );

  share
    .command("cat <share>")
    .description("print a text file from a published share")
    .option("--slug <slug>", "explicit share path slug")
    .action(
      async (target: string, opts: ShareTargetOptions, command: Command) => {
        await deps.withContext(command, "share cat", async (ctx: any) => {
          const resolved = await resolveShareTarget({
            ctx,
            deps,
            target,
            slug: opts.slug,
          });
          if (resolved.path === ".") {
            throw new Error("share cat requires a file path inside the share");
          }
          const fs = await deps.resolveShareFilesystem(ctx, resolved.share);
          const projectPath = shareProjectPath(resolved.share, resolved.path);
          const content = String(await fs.readFile(projectPath, "utf8"));
          if (!ctx.globals.json && ctx.globals.output !== "json") {
            deps.emitProjectFileCatHumanContent(content);
            return null;
          }
          return {
            slug: resolved.slug,
            path: resolved.path,
            project_id: resolved.share.project_id,
            project_path: projectPath,
            content,
            bytes: Buffer.byteLength(content),
          };
        });
      },
    );

  share
    .command("get <share> [dest]")
    .description("download a file from a published share")
    .option("--slug <slug>", "explicit share path slug")
    .option("--no-parents", "do not create destination parent directories")
    .action(
      async (
        target: string,
        dest: string | undefined,
        opts: ShareTargetOptions & { parents?: boolean },
        command: Command,
      ) => {
        await deps.withContext(command, "share get", async (ctx: any) => {
          const resolved = await resolveShareTarget({
            ctx,
            deps,
            target,
            slug: opts.slug,
          });
          if (resolved.path === ".") {
            throw new Error("share get requires a file path inside the share");
          }
          const fs = await deps.resolveShareFilesystem(ctx, resolved.share);
          const projectPath = shareProjectPath(resolved.share, resolved.path);
          const content = await fs.readFile(projectPath);
          const data = Buffer.isBuffer(content)
            ? content
            : Buffer.from(String(content));
          const destination =
            dest?.trim() || defaultDownloadDestination(resolved.path);
          if (opts.parents !== false) {
            await deps.mkdirLocal(dirname(destination), { recursive: true });
          }
          await deps.writeFileLocal(destination, data);
          return {
            slug: resolved.slug,
            path: resolved.path,
            project_id: resolved.share.project_id,
            project_path: projectPath,
            dest: destination,
            bytes: data.length,
          };
        });
      },
    );

  share
    .command("copy <share>")
    .description("copy a published share path to one of your projects")
    .option("--slug <slug>", "explicit share path slug")
    .option("-w, --project <project>", "destination project id or name")
    .option("--new-project", "create a new project and copy into it")
    .option("--dest <path>", "destination path for --project copies")
    .option("--title <title>", "new project title for --new-project")
    .option("--no-recursive", "copy only the selected file")
    .option("--wait", "wait for the copy operation to finish")
    .action(
      async (target: string, opts: ShareCopyOptions, command: Command) => {
        await deps.withContext(command, "share copy", async (ctx: any) => {
          const resolved = await resolveShareTarget({
            ctx,
            deps,
            target,
            slug: opts.slug,
          });
          const options = { recursive: opts.recursive !== false };
          if (copyMode(opts) === "new-project") {
            const response = (await deps.hubCallByName(
              ctx,
              "publicDirectoryShares.copyToNewProject",
              [
                {
                  slug: resolved.slug,
                  path: resolved.path,
                  title: opts.title,
                  options,
                },
              ],
            )) as CopyPublicDirectoryShareToNewProjectResponse;
            return await maybeWaitForCopy({
              ctx,
              deps,
              response,
              wait: opts.wait,
            });
          }
          const response = (await deps.hubCallByName(
            ctx,
            "publicDirectoryShares.copyToProject",
            [
              {
                slug: resolved.slug,
                path: resolved.path,
                destination_project_id: opts.project,
                destination_path: opts.dest,
                options,
              },
            ],
          )) as CopyPublicDirectoryShareToProjectResponse;
          return await maybeWaitForCopy({
            ctx,
            deps,
            response,
            wait: opts.wait,
          });
        });
      },
    );

  return share;
}
