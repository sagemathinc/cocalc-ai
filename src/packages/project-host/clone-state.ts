import { rm } from "node:fs/promises";
import { join } from "node:path";

export const CLONED_PROJECT_RESET_PATHS = [
  ".cache/cocalc/project",
  ".local/share/cocalc/persist",
  ".local/share/cocalc/chats",
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
