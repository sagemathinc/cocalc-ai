import fs from "node:fs";

type Command = "rm" | "rmdir";

type ParsedArgs = {
  command: Command;
  root: string;
  targetPath: string;
  recursive: boolean;
  force: boolean;
};

function usage(): never {
  throw new Error(
    "usage: project-host privileged-rm-helper <rm|rmdir> --root <root> --path <relative-path> [--recursive] [--force]",
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    usage();
  }
  const command = argv[0];
  if (command !== "rm" && command !== "rmdir") {
    usage();
  }
  let root = "";
  let targetPath = "";
  let recursive = false;
  let force = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--root":
        root = argv[++i] ?? "";
        break;
      case "--path":
        targetPath = argv[++i] ?? "";
        break;
      case "--recursive":
        recursive = true;
        break;
      case "--force":
        force = true;
        break;
      default:
        throw new Error(`unknown privileged-rm-helper option: ${arg}`);
    }
  }
  if (!root || !targetPath) {
    usage();
  }
  if (!root.startsWith("/")) {
    throw new Error(`privileged-rm-helper root must be absolute: ${root}`);
  }
  if (targetPath.startsWith("/")) {
    throw new Error(
      `privileged-rm-helper path must be relative: ${targetPath}`,
    );
  }
  for (const part of targetPath.split("/")) {
    if (!part || part === "." || part === "..") {
      throw new Error(
        `privileged-rm-helper path must stay beneath root: ${targetPath}`,
      );
    }
  }
  return { command, root, targetPath, recursive, force };
}

export function runPrivilegedRmHelper(argv: string[]): void {
  const { command, root, targetPath, recursive, force } = parseArgs(argv);
  const realRoot = fs.realpathSync(root);
  const rootStat = fs.statSync(realRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(
      `privileged-rm-helper root is not a directory: ${realRoot}`,
    );
  }
  const { SandboxRoot } = require("@cocalc/openat2") as {
    SandboxRoot: new (root: string) => {
      rm(path: string, recursive?: boolean, force?: boolean): void;
      rmdir(path: string): void;
    };
  };
  const sandbox = new SandboxRoot(realRoot);
  if (command === "rm") {
    sandbox.rm(targetPath, recursive, force);
    return;
  }
  if (recursive) {
    sandbox.rm(targetPath, true, false);
    return;
  }
  sandbox.rmdir(targetPath);
}

export const __test__ = {
  parseArgs,
};
