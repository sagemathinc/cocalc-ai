import type { FilesystemClient } from "@cocalc/conat/files/fs";

export async function isDirViaFs(
  fs: Pick<FilesystemClient, "stat">,
  path: string,
): Promise<boolean> {
  try {
    const stats = await fs.stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}
