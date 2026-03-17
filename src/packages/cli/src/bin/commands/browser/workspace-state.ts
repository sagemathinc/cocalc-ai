import {
  resolveWorkspaceForPath,
  selectionMatchesWorkspacePath,
  type WorkspaceRecord,
  type WorkspaceSelection,
} from "@cocalc/conat/workspaces";

export type BrowserWorkspaceStateOpenFile = {
  project_id: string;
  title?: string;
  path: string;
};

export type BrowserWorkspaceStateFileSummary = {
  title: string;
  path: string;
  kind: "workspace" | "unscoped";
  workspace_id: string | null;
  workspace_title: string | null;
  in_selected_scope: boolean;
};

export type BrowserWorkspaceStateWorkspaceSummary = {
  workspace_id: string;
  title: string;
  root_path: string;
  chat_path: string | null;
  pinned: boolean;
  selected: boolean;
  open_file_count: number;
  visible_file_count: number;
};

export type BrowserWorkspaceStateSummary = {
  selection: WorkspaceSelection;
  selection_label: string;
  selected_workspace: BrowserWorkspaceStateWorkspaceSummary | null;
  open_file_count: number;
  visible_file_count: number;
  unscoped_open_file_count: number;
  workspaces: BrowserWorkspaceStateWorkspaceSummary[];
  open_files: BrowserWorkspaceStateFileSummary[];
};

function workspaceTitle(record: WorkspaceRecord): string {
  return `${record.theme?.title ?? ""}`.trim() || record.root_path;
}

export function summarizeBrowserWorkspaceState({
  records,
  selection,
  openFiles,
}: {
  records: WorkspaceRecord[];
  selection: WorkspaceSelection;
  openFiles: BrowserWorkspaceStateOpenFile[];
}): BrowserWorkspaceStateSummary {
  const open_files = openFiles.map((row) => {
    const workspace = resolveWorkspaceForPath(records, row.path);
    return {
      title: `${row.title ?? ""}`.trim(),
      path: row.path,
      kind: workspace ? "workspace" : "unscoped",
      workspace_id: workspace?.workspace_id ?? null,
      workspace_title: workspace ? workspaceTitle(workspace) : null,
      in_selected_scope: selectionMatchesWorkspacePath(
        selection,
        records,
        row.path,
      ),
    } satisfies BrowserWorkspaceStateFileSummary;
  });

  const workspaces = records.map((record) => {
    const open_file_count = open_files.filter(
      (row) => row.workspace_id === record.workspace_id,
    ).length;
    const visible_file_count = open_files.filter(
      (row) =>
        row.workspace_id === record.workspace_id && row.in_selected_scope,
    ).length;
    return {
      workspace_id: record.workspace_id,
      title: workspaceTitle(record),
      root_path: record.root_path,
      chat_path: record.chat_path ?? null,
      pinned: record.pinned === true,
      selected:
        selection.kind === "workspace" &&
        selection.workspace_id === record.workspace_id,
      open_file_count,
      visible_file_count,
    } satisfies BrowserWorkspaceStateWorkspaceSummary;
  });

  const selected_workspace =
    selection.kind === "workspace"
      ? (workspaces.find(
          (row) => row.workspace_id === selection.workspace_id,
        ) ?? null)
      : null;

  const selection_label =
    selection.kind === "all"
      ? "All tabs"
      : selection.kind === "unscoped"
        ? "Unscoped"
        : (selected_workspace?.title ?? `Workspace ${selection.workspace_id}`);

  return {
    selection,
    selection_label,
    selected_workspace,
    open_file_count: open_files.length,
    visible_file_count: open_files.filter((row) => row.in_selected_scope)
      .length,
    unscoped_open_file_count: open_files.filter(
      (row) => row.workspace_id == null,
    ).length,
    workspaces,
    open_files,
  };
}
