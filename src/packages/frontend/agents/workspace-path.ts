/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function relativeAgentWorkingDirectory(
  workingDirectory: string | undefined,
  projectHome: string,
): string | undefined {
  const directory = workingDirectory?.trim().replace(/\/+$/, "");
  const home = projectHome.trim().replace(/\/+$/, "");
  if (!directory || !home) return undefined;
  if (directory === home) return "~/";
  if (directory.startsWith(`${home}/`)) {
    return `${directory.slice(home.length + 1)}/`;
  }
  return `${directory}/`;
}

export function effectiveNewAgentWorkingDirectory({
  projectId,
  directoryProjectId,
  directory,
  projectHome,
}: {
  projectId?: string;
  directoryProjectId?: string;
  directory: string;
  projectHome: string;
}): string {
  return projectId && directoryProjectId !== projectId
    ? projectHome
    : directory;
}

type WorkingDirectoryFilesystem = {
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<unknown>;
  stat: (path: string) => Promise<{ isDirectory: () => boolean }>;
};

export class MissingAgentWorkingDirectoryError extends Error {
  constructor(public readonly path: string) {
    super(`Working directory ${JSON.stringify(path)} does not exist`);
    this.name = "MissingAgentWorkingDirectoryError";
  }
}

export async function assertAgentWorkingDirectory(
  fs: Pick<WorkingDirectoryFilesystem, "stat">,
  path: string,
): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    throw new MissingAgentWorkingDirectoryError(path);
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Working directory ${JSON.stringify(path)} is not a directory. Choose an existing directory.`,
    );
  }
}

export async function createAgentWorkingDirectory(
  fs: WorkingDirectoryFilesystem,
  path: string,
): Promise<void> {
  await fs.mkdir(path, { recursive: true });
  await assertAgentWorkingDirectory(fs, path);
}
