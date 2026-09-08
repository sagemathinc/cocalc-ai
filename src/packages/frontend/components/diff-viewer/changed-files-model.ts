import type { GitStatus } from "@pierre/trees";

export interface ChangedFileEntry {
  id: string;
  path: string;
  oldPath?: string;
  status?: GitStatus;
  commentCount?: number;
}

// Do not normalize Git paths: a deleted file can conflict with a newly added
// directory, and normalization could silently select a different review entry.
export function prepareChangedFiles(files: readonly ChangedFileEntry[]) {
  const byPath = new Map<string, ChangedFileEntry>();
  const ids = new Set<string>();
  for (const file of files) {
    if (
      !file.path ||
      file.path.includes("\0") ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      byPath.has(file.path) ||
      ids.has(file.id)
    )
      return {
        error:
          "These paths cannot be represented unambiguously as a tree. Use the file list.",
        byPath,
      };
    byPath.set(file.path, file);
    ids.add(file.id);
  }
  for (const path of byPath.keys()) {
    for (
      let slash = path.indexOf("/");
      slash !== -1;
      slash = path.indexOf("/", slash + 1)
    ) {
      if (byPath.has(path.slice(0, slash))) {
        return {
          error:
            "This review replaces a file with a directory (or vice versa). Use the file list to retain both entries.",
          byPath,
        };
      }
    }
  }
  return { error: "", byPath };
}

export function changedFileLabel(file: ChangedFileEntry): string {
  return [
    file.oldPath && file.oldPath !== file.path
      ? `${file.oldPath} -> ${file.path}`
      : file.path,
    file.status,
    file.commentCount ? `${file.commentCount} comments` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}
