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

export class AgentProjectHomeNotReadyError extends Error {
  constructor() {
    super(
      "The project workspace is still being prepared. Please try again shortly.",
    );
    this.name = "AgentProjectHomeNotReadyError";
  }
}

class AgentWorkingDirectoryNotDirectoryError extends Error {}

function isMissingPathError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return (
    code === "ENOENT" ||
    /\bENOENT\b|no such file|does not exist/i.test(`${error}`)
  );
}

export async function assertAgentWorkingDirectory(
  fs: Pick<WorkingDirectoryFilesystem, "stat">,
  path: string,
): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new MissingAgentWorkingDirectoryError(path);
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new AgentWorkingDirectoryNotDirectoryError(
      `Working directory ${JSON.stringify(path)} is not a directory. Choose an existing directory.`,
    );
  }
}

export async function ensureAgentProjectHomeReady(
  fs: WorkingDirectoryFilesystem,
  path: string,
  { attempts = 30, retryDelayMs = 1000 } = {},
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await assertAgentWorkingDirectory(fs, path);
      return;
    } catch (error) {
      if (error instanceof AgentWorkingDirectoryNotDirectoryError) throw error;
      if (error instanceof MissingAgentWorkingDirectoryError) {
        try {
          await createAgentWorkingDirectory(fs, path);
          return;
        } catch {
          // A newly started project's filesystem may not be ready yet.
        }
      }
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new AgentProjectHomeNotReadyError();
}

export async function createAgentWorkingDirectory(
  fs: WorkingDirectoryFilesystem,
  path: string,
): Promise<void> {
  await fs.mkdir(path, { recursive: true });
  await assertAgentWorkingDirectory(fs, path);
}
