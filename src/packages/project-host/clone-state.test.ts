import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import {
  CLONED_PROJECT_RESET_PATHS,
  resetClonedProjectState,
} from "./clone-state";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("resetClonedProjectState", () => {
  it("removes copied project cache but keeps other project-local CoCalc data", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cocalc-clone-state-"));
    for (const relativePath of CLONED_PROJECT_RESET_PATHS) {
      await mkdir(path.join(root, relativePath), { recursive: true });
    }
    const persistDir = path.join(root, ".local/share/cocalc/persist");
    const chatsDir = path.join(root, ".local/share/cocalc/chats");
    await mkdir(persistDir, { recursive: true });
    await mkdir(chatsDir, { recursive: true });
    const keepDir = path.join(root, ".local/share/cocalc/rootfs");
    await mkdir(keepDir, { recursive: true });

    await resetClonedProjectState(root);

    for (const relativePath of CLONED_PROJECT_RESET_PATHS) {
      expect(await exists(path.join(root, relativePath))).toBe(false);
    }
    expect(await exists(persistDir)).toBe(true);
    expect(await exists(chatsDir)).toBe(true);
    expect(await exists(keepDir)).toBe(true);
  });
});
