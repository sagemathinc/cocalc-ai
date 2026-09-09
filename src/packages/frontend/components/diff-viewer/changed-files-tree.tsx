import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { useAppearance } from "@cocalc/frontend/appearance/use-appearance";
import { changedFileLabel, prepareChangedFiles } from "./changed-files-model";
import type { ChangedFileEntry } from "./changed-files-model";
import { REVIEW_VIEWPORT_HEIGHT } from "./review-viewport";
import { watchTreeOverflow } from "./tree-overflow";
import {
  readTreeExpansion,
  watchTreeExpansion,
  treeDirectoryPaths,
} from "./tree-expansion";

export interface ChangedFilesTreeProps {
  files: readonly ChangedFileEntry[];
  activeId?: string;
  onSelect: (id: string) => void;
  expansionScope?: string;
}

export default function ChangedFilesTree(props: ChangedFilesTreeProps) {
  const prepared = prepareChangedFiles(props.files);
  if (prepared.error) return <div role="status">{prepared.error}</div>;
  return <Tree {...props} />;
}

function Tree({
  files,
  activeId,
  onSelect,
  expansionScope,
}: ChangedFilesTreeProps) {
  const { resolved } = useAppearance();
  const [query, setQuery] = useState("");
  const [overflow, setOverflow] = useState({ above: false, below: false });
  const updating = useRef(false);
  const saveExpansion = useRef<() => void>(() => {});
  const latest = useRef({
    files,
    onSelect,
    byPath: new Map(files.map((file) => [file.path, file])),
  });
  useLayoutEffect(() => {
    latest.current = {
      files,
      onSelect,
      byPath: new Map(files.map((file) => [file.path, file])),
    };
  }, [files, onSelect]);
  const select = (paths: readonly string[]) => {
    if (updating.current) return;
    const file = latest.current.byPath.get(paths.at(-1) ?? "");
    if (file) latest.current.onSelect(file.id);
  };
  const decorate = ({ item }: { item: { path: string } }) => {
    const file = latest.current.byPath.get(item.path);
    return file
      ? {
          text: [
            file.status,
            file.commentCount ? `${file.commentCount} comments` : "",
          ]
            .filter(Boolean)
            .join("; "),
          title: changedFileLabel(file),
        }
      : null;
  };
  const { model } = useFileTree({
    paths: [],
    initialExpansion: "closed",
    flattenEmptyDirectories: true,
    dragAndDrop: false,
    renaming: false,
    search: false,
    fileTreeSearchMode: "hide-non-matches",
    composition: { contextMenu: { enabled: false } },
    onSelectionChange: (paths) => select(paths),
    renderRowDecoration: (context) => decorate(context),
  });
  const signature = JSON.stringify(files.map((file) => file.path));
  useEffect(
    () =>
      watchTreeOverflow(
        () => model.getFileTreeContainer(),
        (next) =>
          setOverflow((previous) =>
            previous.above === next.above && previous.below === next.below
              ? previous
              : next,
          ),
      ),
    [model],
  );
  useEffect(() => {
    updating.current = true;
    try {
      // End the old search session before replacing paths. Otherwise clearing
      // it restores expansion from the previous review and hides new folders.
      model.setSearch(null);
      model.resetPaths(JSON.parse(signature), {
        // With initialExpansion=open, Trees treats an explicit [] as open too.
        initialExpandedPaths:
          readTreeExpansion(expansionScope) ??
          treeDirectoryPaths(JSON.parse(signature)),
      });
    } finally {
      updating.current = false;
    }
    const persistence = watchTreeExpansion(
      model,
      JSON.parse(signature),
      expansionScope,
    );
    saveExpansion.current = persistence.flush;
    return persistence.dispose;
  }, [model, signature, expansionScope]);
  useEffect(() => {
    const statuses: GitStatusEntry[] = files.flatMap((file) =>
      file.status ? [{ path: file.path, status: file.status }] : [],
    );
    model.setGitStatus(statuses);
    // Re-render row decorations even when only comment counts changed.
    model.setComposition(model.getComposition());
  }, [model, files]);
  useEffect(() => {
    saveExpansion.current();
    model.setSearch(query || null);
  }, [model, query, signature, expansionScope]);
  useEffect(() => {
    updating.current = true;
    try {
      const path = files.find((file) => file.id === activeId)?.path;
      for (const selected of model.getSelectedPaths()) {
        if (selected !== path) model.getItem(selected)?.deselect();
      }
      if (path) model.getItem(path)?.select();
    } finally {
      updating.current = false;
    }
  }, [model, files, activeId]);
  return (
    <div
      style={{
        minWidth: 0,
        height: REVIEW_VIEWPORT_HEIGHT,
        minHeight: 200,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <strong style={{ display: "block", padding: "8px 8px 0" }}>
        {files.length} changed {files.length === 1 ? "file" : "files"}
      </strong>
      <label style={{ display: "block", padding: 8 }}>
        Filter changed files
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ width: "100%", boxSizing: "border-box" }}
        />
      </label>
      <FileTree
        model={model}
        aria-label="Changed files"
        style={{
          display: "block",
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          colorScheme: resolved,
          border: `1px solid ${UI_COLORS.border}`,
        }}
      />
      <div
        role="status"
        aria-label="File tree scrolling"
        style={{
          height: 26,
          flexShrink: 0,
          fontSize: 12,
          textAlign: "center",
          color: UI_COLORS.secondary,
        }}
      >
        {overflow.above && overflow.below
          ? "More files before and after this section"
          : overflow.below
            ? "More files after this section"
            : overflow.above
              ? "More files before this section"
              : ""}
      </div>
    </div>
  );
}
