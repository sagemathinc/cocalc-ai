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
  constructor(cause?: unknown) {
    super(
      "The project workspace is still being prepared. Please try again shortly." +
        (cause == null ? "" : ` Last filesystem error: ${cause}`),
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

function isFilesystemAccessDenied(error: unknown): boolean {
  const code = (error as { code?: string | number } | null)?.code;
  return (
    code === "EACCES" ||
    code === "EPERM" ||
    `${code}` === "401" ||
    `${code}` === "403" ||
    /not authorized|unauthorized|forbidden|permission denied|account is banned/i.test(
      `${error}`,
    )
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
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await assertAgentWorkingDirectory(fs, path);
      return;
    } catch (error) {
      if (
        error instanceof AgentWorkingDirectoryNotDirectoryError ||
        isFilesystemAccessDenied(error)
      )
        throw error;
      lastError = error;
      if (error instanceof MissingAgentWorkingDirectoryError) {
        try {
          await createAgentWorkingDirectory(fs, path);
          return;
        } catch (error) {
          if (isFilesystemAccessDenied(error)) throw error;
          lastError = error;
          // A newly started project's filesystem may not be ready yet.
        }
      }
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new AgentProjectHomeNotReadyError(lastError);
}

export async function createAgentWorkingDirectory(
  fs: WorkingDirectoryFilesystem,
  path: string,
): Promise<void> {
  await fs.mkdir(path, { recursive: true });
  await assertAgentWorkingDirectory(fs, path);
}
