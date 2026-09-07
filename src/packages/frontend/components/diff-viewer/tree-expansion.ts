import type { FileTree } from "@pierre/trees";

const PREFIX = "cocalc:review-tree-expansion:v1:";

export function treeDirectoryPaths(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
      directories.add(path.slice(0, i + 1));
    }
  }
  return [...directories];
}

export function readTreeExpansion(scope?: string): string[] | undefined {
  if (!scope) return;
  try {
    const raw = localStorage.getItem(PREFIX + scope);
    if (!raw || raw.length > 1_000_000) return;
    const paths = JSON.parse(raw);
    if (
      Array.isArray(paths) &&
      paths.length <= 20_000 &&
      paths.every((path) => typeof path === "string" && path.endsWith("/"))
    )
      return paths;
  } catch {
    // View preferences must not prevent reviewing when storage is unavailable.
  }
}

export function watchTreeExpansion(
  model: Pick<FileTree, "subscribe" | "getItem" | "getSearchValue">,
  paths: readonly string[],
  scope?: string,
): { dispose: () => void; flush: () => void } {
  if (!scope) return { dispose: () => {}, flush: () => {} };
  const directories = treeDirectoryPaths(paths);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous = JSON.stringify(readTreeExpansion(scope));
  const save = () => {
    if (model.getSearchValue()) return;
    const expanded = [...directories].filter((path) => {
      const item = model.getItem(path);
      return item != null && "isExpanded" in item && item.isExpanded();
    });
    const value = JSON.stringify(expanded);
    if (
      value === previous ||
      value.length > 1_000_000 ||
      expanded.length > 20_000
    )
      return;
    try {
      localStorage.setItem(PREFIX + scope, value);
      previous = value;
    } catch {
      // Quota or privacy settings do not affect the live tree.
    }
  };
  const unsubscribe = model.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(save, 150);
  });
  return {
    flush: save,
    dispose: () => {
      unsubscribe();
      clearTimeout(timer);
      save();
    },
  };
}
