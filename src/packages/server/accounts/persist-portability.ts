/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { promises as fs } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

import type { AccountPersistFileV1 } from "@cocalc/conat/inter-bay/api";
import { syncFiles } from "@cocalc/conat/persist/context";

const MAX_ACCOUNT_PERSIST_FILES = 2_000;
const MAX_ACCOUNT_PERSIST_BYTES = 64 * 1024 * 1024;

type AccountPersistRoot = AccountPersistFileV1["root"];

interface AccountPersistRootPath {
  root: AccountPersistRoot;
  path: string;
}

function resolveTemplateBase(base: string, token: string, id: string): string {
  if (base.includes(`{${token}}`)) {
    return base.replaceAll(`{${token}}`, id);
  }
  if (base.includes(`:${token}`)) {
    return base.replaceAll(`:${token}`, id);
  }
  return join(base, id);
}

export function getAccountPersistRootPaths(
  account_id: string,
): AccountPersistRootPath[] {
  if (!syncFiles.local && !syncFiles.localAccounts) {
    throw new Error("account persist storage is not initialized");
  }
  const local = syncFiles.localAccounts
    ? resolveTemplateBase(syncFiles.localAccounts, "account_id", account_id)
    : join(syncFiles.local, "accounts", account_id);
  const roots: AccountPersistRootPath[] = [{ root: "local", path: local }];
  if (syncFiles.archive) {
    roots.push({
      root: "archive",
      path: join(syncFiles.archive, "accounts", account_id),
    });
  }
  if (syncFiles.backup) {
    roots.push({
      root: "backup",
      path: join(syncFiles.backup, "accounts", account_id),
    });
  }
  return roots;
}

function validateRelativePath(relative_path: string): string {
  const normalized = relative_path.replaceAll("\\", "/").trim();
  if (!normalized || isAbsolute(normalized)) {
    throw new Error(`invalid account persist relative path: ${relative_path}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`invalid account persist relative path: ${relative_path}`);
  }
  return normalized;
}

function targetPath(rootPath: string, relative_path: string): string {
  const root = resolve(rootPath);
  const target = resolve(root, validateRelativePath(relative_path));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(
      `account persist path escapes account root: ${relative_path}`,
    );
  }
  return target;
}

async function collectRootFiles({
  account_id,
  root,
  rootPath,
  totals,
}: {
  account_id: string;
  root: AccountPersistRoot;
  rootPath: string;
  totals: { files: number; bytes: number };
}): Promise<AccountPersistFileV1[]> {
  try {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const files: AccountPersistFileV1[] = [];
  const pending = [rootPath];
  const resolvedRoot = resolve(rootPath);
  while (pending.length > 0) {
    const dir = pending.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.stat(path);
      totals.files += 1;
      totals.bytes += stat.size;
      if (totals.files > MAX_ACCOUNT_PERSIST_FILES) {
        throw new Error(
          `account ${account_id} persist store has more than ${MAX_ACCOUNT_PERSIST_FILES} files`,
        );
      }
      if (totals.bytes > MAX_ACCOUNT_PERSIST_BYTES) {
        throw new Error(
          `account ${account_id} persist store is larger than ${MAX_ACCOUNT_PERSIST_BYTES} bytes`,
        );
      }
      const relativePath = relative(resolvedRoot, path).split(sep).join("/");
      files.push({
        root,
        relative_path: validateRelativePath(relativePath),
        data_base64: (await fs.readFile(path)).toString("base64"),
        mode: stat.mode & 0o777,
        mtime_ms: stat.mtimeMs,
      });
    }
  }
  return files;
}

export async function loadAccountPersistState(
  account_id: string,
): Promise<AccountPersistFileV1[]> {
  const totals = { files: 0, bytes: 0 };
  const files: AccountPersistFileV1[] = [];
  for (const { root, path } of getAccountPersistRootPaths(account_id)) {
    files.push(
      ...(await collectRootFiles({ account_id, root, rootPath: path, totals })),
    );
  }
  return files;
}

export async function clearAccountPersistState(
  account_id: string,
): Promise<void> {
  await Promise.all(
    getAccountPersistRootPaths(account_id).map(({ path }) =>
      fs.rm(path, { recursive: true, force: true }),
    ),
  );
}

export async function restoreAccountPersistState({
  account_id,
  files,
}: {
  account_id: string;
  files: AccountPersistFileV1[];
}): Promise<void> {
  await clearAccountPersistState(account_id);
  const roots = new Map(
    getAccountPersistRootPaths(account_id).map(({ root, path }) => [
      root,
      path,
    ]),
  );
  for (const file of files) {
    const rootPath = roots.get(file.root);
    if (!rootPath) {
      throw new Error(`unknown account persist root: ${file.root}`);
    }
    const path = targetPath(rootPath, file.relative_path);
    const data = Buffer.from(file.data_base64, "base64");
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, data);
    if (file.mode != null) {
      await fs.chmod(path, file.mode);
    }
    if (file.mtime_ms != null) {
      const mtime = new Date(file.mtime_ms);
      await fs.utimes(path, mtime, mtime);
    }
  }
}
