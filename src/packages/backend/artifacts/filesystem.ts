/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { posix } from "node:path";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import type { ArtifactCatalogJournal } from "./journal";

/** Install once on a service-owned sandbox, never on project-controlled code. */
export function journalArtifactFilesystem(
  fs: SandboxedFilesystem,
  project_id: string,
  journal: ArtifactCatalogJournal,
  home = "/home/user",
) {
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
  ): Promise<T> => {
    const affected = new Set<string>();
    const roots = await paths(input);
    const destination =
      renameTo == null ? undefined : (await paths(renameTo))[0];
    for (const path of [...roots, ...(destination ? [destination] : [])]) {
      if (path.endsWith(".chat")) affected.add(path);
      // Directory changes invalidate all already indexed descendants. Unknown
      // copied/moved chats are discovered separately by background backfill.
      let after = "";
      while (true) {
        const page = journal.descendants(project_id, path, after);
        for (const source of page) {
          if (source.chat_path.startsWith(path + "/")) {
            affected.add(source.chat_path);
            if (destination && path === roots[0])
              affected.add(destination + source.chat_path.slice(path.length));
          }
        }
        if (page.length < 100) break;
        after = page[page.length - 1].chat_path;
      }
    }
    const tokens: string[] = [];
    try {
      for (const chat_path of affected)
        tokens.push(journal.beginWrite({ project_id, chat_path }));
      return await run();
    } finally {
      for (const token of tokens) journal.finishWrite(token);
    }
  };
  for (const name of [
    "writeFile",
    "appendFile",
    "unlink",
    "rm",
    "rmdir",
  ] as const) {
    const original = fs[name].bind(fs) as (...args: any[]) => Promise<any>;
    (fs as any)[name] = (...args: any[]) =>
      mutation(args[0], () => original(...args));
  }
  for (const name of ["rename", "move"] as const) {
    const original = fs[name].bind(fs) as (...args: any[]) => Promise<any>;
    (fs as any)[name] = (...args: any[]) =>
      mutation(args[0], () => original(...args), args[1]);
  }
  for (const name of ["copyFile", "cp"] as const) {
    const original = fs[name].bind(fs) as (...args: any[]) => Promise<any>;
    (fs as any)[name] = (...args: any[]) =>
      mutation(args[1], () => original(...args));
  }
  return fs;
}

/** Bound bytes while reading, not merely with a racy pre-read stat. */
export async function readArtifactSource(
  fs: SandboxedFilesystem,
  path: string,
  maxBytes = 16 * 1024 * 1024,
): Promise<unknown[]> {
  let stream: Awaited<ReturnType<typeof fs.createReadStream>>;
  try {
    stream = await fs.createReadStream(path, { end: maxBytes });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maxBytes)
        throw Error("artifact source exceeds catalog read limit");
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
