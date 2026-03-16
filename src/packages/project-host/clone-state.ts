import { rm } from "node:fs/promises";
import { join } from "node:path";

export const CLONED_PROJECT_RESET_PATHS = [
  // XDG cache directories are disposable and should not be cloned as
  // authoritative project state.
  ".cache",
  ".local/cache",
  // Preserve Codex thread/history state, but do not silently clone persisted
  // auth into a new project.
  ".codex/auth.json",
];

export async function resetClonedProjectState(
  projectRoot: string,
): Promise<void> {
  await Promise.all(
    CLONED_PROJECT_RESET_PATHS.map(async (relativePath) => {
      await rm(join(projectRoot, relativePath), {
        recursive: true,
        force: true,
      });
    }),
  );
}
