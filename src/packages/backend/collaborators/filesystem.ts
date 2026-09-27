/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { posix } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import type { CollaborationJournal } from "./journal";
import { readArtifactSource } from "@cocalc/backend/artifacts/filesystem";
import { withCollaborationCopyLock } from "./copy-locks";
export { readArtifactSource as readCollaborationSource } from "@cocalc/backend/artifacts/filesystem";

const installed = new WeakSet<SandboxedFilesystem>();
export function collaborationCopySourceFingerprint(rows: unknown[]): string {
  const normalized = rows
    .map((row) =>
      JSON.stringify(row, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, value[key]]),
            )
          : value,
      ),
    )
    .sort();
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Write-ahead intent belongs to the trusted filesystem service, not user code. */
export function journalCollaborationFilesystem(
  fs: SandboxedFilesystem,
  project_id: string,
  journal: CollaborationJournal,
  home = "/home/user",
) {
  if (installed.has(fs)) return fs;
  installed.add(fs);
  // cp internally calls copyFile. Those calls belong to the same outer intent.
  const copying = new AsyncLocalStorage<boolean>();
  const bypassing = new AsyncLocalStorage<boolean>();
  const guarded = async (
    original: (...args: any[]) => Promise<any>,
    args: any[],
    run: () => Promise<any>,
  ) => {
    if (bypassing.getStore() || !(await journal.isEnabled()))
      return bypassing.run(true, () => original(...args));
    return run();
  };
  const paths = async (input: string | string[]) =>
    Promise.all(
      (Array.isArray(input) ? input : [input]).map(async (path) =>
        posix.resolve(home, await fs.canonicalSyncIdentityPath(path)),
      ),
    );
  const mutation = async <T>(
    input: string | string[],
    run: () => Promise<T>,
    renameTo?: string,
    exclusive = false,
  ): Promise<T> => {
    const affected = new Set<string>();
    const moves = new Map<string, string>();
    const roots = await paths(input);
    const destination =
      renameTo == null ? undefined : (await paths(renameTo))[0];
    if (
      destination &&
      /\.(sage-)?chat$/.test(roots[0]) &&
      /\.(sage-)?chat$/.test(destination) &&
      destination !== roots[0]
    )
      moves.set(roots[0], destination);
    for (const path of [...roots, ...(destination ? [destination] : [])]) {
      if (/\.(sage-)?chat$/.test(path)) affected.add(path);
      let after = "";
      while (true) {
        const page = journal.descendants(project_id, path, after);
        for (const source of page) {
          affected.add(source.chat_path);
          if (destination && path === roots[0]) {
            const to = destination + source.chat_path.slice(path.length);
            affected.add(to);
            if (to !== source.chat_path) moves.set(source.chat_path, to);
          }
          if (affected.size > 1000)
            throw Error("collaboration mutation affects too many sources");
        }
        if (page.length < 100) break;
        after = page[page.length - 1].chat_path;
      }
    }
    const perform = async () => {
      const tokens: string[] = [];
      const relocations: string[] = [];
      let succeeded = false;
      try {
        for (const chat_path of affected)
          tokens.push(journal.beginWrite({ project_id, chat_path }));
        for (const [from_path, to_path] of moves)
          relocations.push(
            journal.beginRelocation(
              { project_id, chat_path: from_path },
              to_path,
            ),
          );
        const result = await run();
        succeeded = true;
        return result;
      } finally {
        for (const operation_id of relocations)
          journal.finishRelocation(operation_id, succeeded);
        for (const token of tokens) journal.finishWrite(token);
      }
    };
    return exclusive
      ? withCollaborationCopyLock(
          [...affected].map((chat_path) => ({ project_id, chat_path })),
          perform,
        )
      : perform();
  };
  for (const name of [
    "writeFile",
    "writeFileDelta",
    "appendFile",
    "unlink",
    "rm",
    "rmdir",
  ] as const) {
    if (typeof fs[name] !== "function") continue;
    const original = fs[name].bind(fs) as (...args: any[]) => Promise<any>;
    (fs as any)[name] = (...args: any[]) =>
      guarded(original, args, () =>
        mutation(
          args[0],
          () =>
            // Atomic saves rename a temporary file internally. Those nested
            // calls share this write intent, not a relocation/copy operation.
            // Other filesystem decorators (including artifacts) still run.
            name === "writeFile" || name === "writeFileDelta"
              ? bypassing.run(true, () => original(...args))
              : original(...args),
          undefined,
          ["unlink", "rm", "rmdir"].includes(name),
        ),
      );
  }
  for (const name of ["rename", "move"] as const) {
    const original = fs[name].bind(fs) as (...args: any[]) => Promise<any>;
    (fs as any)[name] = (...args: any[]) =>
      guarded(original, args, () =>
        mutation(args[0], () => original(...args), args[1], true),
      );
  }
  for (const name of ["copyFile", "cp"] as const) {
    const original = fs[name].bind(fs) as (...args: any[]) => Promise<any>;
    (fs as any)[name] = async (...args: any[]) => {
      if (copying.getStore()) return original(...args);
      return guarded(original, args, async () => {
        const from = await paths(args[0]);
        const destination = (await paths(args[1]))[0];
        const candidates = new Map<string, string>();
        let directories = 0;
        const visit = async (root: string, target: string): Promise<void> => {
          if (/\.(sage-)?chat$/.test(target)) candidates.set(target, root);
          if (candidates.size > 1000)
            throw Error("collaboration copy source capacity exceeded");
          if (typeof fs.lstat !== "function") return;
          const stat = args[2]?.dereference
            ? await fs.stat(root)
            : await fs.lstat(root);
          // Follow links only when the underlying copy explicitly dereferences them.
          if (!stat.isDirectory()) return;
          if (++directories > 10_000)
            throw Error(
              "collaboration copy directory discovery capacity exceeded",
            );
          // Dirents avoid a stat and capacity charge for every unrelated data file.
          for (const child of await fs.readdir(root, { withFileTypes: true })) {
            const name = typeof child === "string" ? child : child.name;
            if (
              typeof child !== "string" &&
              !child.isDirectory() &&
              !(args[2]?.dereference && child.isSymbolicLink()) &&
              !/\.(sage-)?chat$/.test(name)
            )
              continue;
            await visit(posix.join(root, name), posix.join(target, name));
          }
        };
        for (const root of from) {
          const target = Array.isArray(args[0])
            ? posix.join(destination, posix.basename(root))
            : destination;
          await visit(root, target);
          let after = "";
          while (true) {
            const page = journal.descendants(project_id, root, after);
            for (const source of page)
              candidates.set(
                target + source.chat_path.slice(root.length),
                source.chat_path,
              );
            if (page.length < 100) break;
            after = page[page.length - 1].chat_path;
          }
        }
        if (candidates.size > 1000)
          throw Error("collaboration copy source capacity exceeded");
        const locked = new Set(candidates.keys());
        let after = "";
        while (true) {
          const page = journal.descendants(project_id, destination, after);
          for (const source of page) locked.add(source.chat_path);
          if (locked.size > 1000)
            throw Error("collaboration copy destination capacity exceeded");
          if (page.length < 100) break;
          after = page[page.length - 1].chat_path;
        }
        return withCollaborationCopyLock(
          [...locked].map((chat_path) => ({
            project_id,
            chat_path,
          })),
          async () => {
            const operations: {
              operation_id: string;
              target: string;
              fresh: boolean;
              fingerprint?: string;
            }[] = [];
            try {
              for (const [target, root] of candidates) {
                let fresh = false;
                let exists = false;
                try {
                  await fs.lstat(target);
                  exists = true;
                } catch (error) {
                  if (error.code === "ENOENT") fresh = true;
                }
                // A known no-clobber skip must not quarantine the existing identity.
                if (exists && args[2]?.force === false) continue;
                const operation = {
                  target,
                  fresh,
                  operation_id: journal.beginCopy(
                    { project_id, chat_path: target },
                    root,
                    fresh,
                  ),
                  fingerprint: undefined as string | undefined,
                };
                operations.push(operation);
                if (fresh)
                  operation.fingerprint = collaborationCopySourceFingerprint(
                    await readArtifactSource(fs, root),
                  );
              }
              const result = await copying.run(true, () =>
                mutation(args[1], () => original(...args)),
              );
              for (const { target, fresh, fingerprint } of operations) {
                if (!fresh) continue;
                const rows = await readArtifactSource(fs, target);
                const stat = await fs.lstat(target);
                if (!stat.isFile())
                  throw Error("copy destination is not a regular chat source");
                if (collaborationCopySourceFingerprint(rows) !== fingerprint)
                  throw Error(
                    "copy source or destination changed; reconciliation required",
                  );
              }
              for (const { operation_id, fresh, fingerprint } of operations)
                if (fresh) journal.finishCopy(operation_id, fingerprint);
              return result;
            } finally {
              // Pending operations become unknown on any ambiguous partial copy/crash.
              for (const { operation_id } of operations)
                journal.finishCopy(operation_id);
            }
          },
        );
      });
    };
  }
  return fs;
}
