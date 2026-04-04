import { execFile } from "node:child_process";
import type { RemoveDirOptions, RemoveOptions } from "@cocalc/conat/files/fs";

const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";
const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export type PrivilegedDeleteCommand = "sandbox-rm" | "sandbox-rmdir";

export type PrivilegedDeleteTarget = {
  command: PrivilegedDeleteCommand;
  root: string;
  rel: string;
  recursive?: boolean;
  force?: boolean;
};

type ExecFileFn = typeof execFile;

function validateDeleteTarget({
  root,
  rel,
}: Pick<PrivilegedDeleteTarget, "root" | "rel">): void {
  if (!root.startsWith("/")) {
    throw new Error(`privileged delete root must be absolute: ${root}`);
  }
  if (!rel || rel.startsWith("/")) {
    throw new Error(`privileged delete path must be relative: ${rel}`);
  }
  for (const part of rel.split("/")) {
    if (part === "." || part === "..") {
      throw new Error(`privileged delete path must stay beneath root: ${rel}`);
    }
  }
}

function commandArgs({
  command,
  root,
  rel,
  recursive,
  force,
}: PrivilegedDeleteTarget): string[] {
  validateDeleteTarget({ root, rel });
  const args = ["-n", STORAGE_WRAPPER, command, root, rel];
  if (recursive) {
    args.push("--recursive");
  }
  if (force) {
    args.push("--force");
  }
  return args;
}

export async function runPrivilegedDelete(
  target: PrivilegedDeleteTarget,
  execFileFn: ExecFileFn = execFile,
): Promise<void> {
  const args = commandArgs(target);
  await new Promise<void>((resolve, reject) => {
    execFileFn(
      "sudo",
      args,
      {
        cwd: "/",
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        reject(
          new Error(
            stderr || stdout || error.message || "privileged delete failed",
          ),
        );
      },
    );
  });
}

export function privilegedRemoveTarget({
  root,
  rel,
  options,
}: {
  root: string;
  rel: string;
  options?: RemoveOptions;
}): PrivilegedDeleteTarget {
  return {
    command: "sandbox-rm",
    root,
    rel,
    recursive: !!options?.recursive,
    force: !!options?.force,
  };
}

export function privilegedRemoveDirTarget({
  root,
  rel,
  options,
}: {
  root: string;
  rel: string;
  options?: RemoveDirOptions;
}): PrivilegedDeleteTarget {
  if (options?.recursive) {
    return {
      command: "sandbox-rm",
      root,
      rel,
      recursive: true,
      force: false,
    };
  }
  return {
    command: "sandbox-rmdir",
    root,
    rel,
    recursive: false,
    force: false,
  };
}

export const __test__ = {
  commandArgs,
  validateDeleteTarget,
};
