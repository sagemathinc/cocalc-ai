import type { EntityTheme } from "@cocalc/frontend/theme/types";

export type WorkspaceTheme = EntityTheme;

export type WorkspaceSource = "manual" | "git-root" | "inferred";

export type WorkspaceRecord = {
  workspace_id: string;
  project_id: string;
  root_path: string;
  theme: WorkspaceTheme;
  pinned: boolean;
  last_used_at: number | null;
  last_active_path: string | null;
  chat_path: string | null;
  created_at: number;
  updated_at: number;
  source: WorkspaceSource;
};

export type WorkspaceSelection =
  | { kind: "all" }
  | { kind: "unscoped" }
  | { kind: "workspace"; workspace_id: string };

export type WorkspaceCreateInput = {
  root_path: string;
  title?: string;
  description?: string;
  color?: string | null;
  accent_color?: string | null;
  icon?: string | null;
  image_blob?: string | null;
  pinned?: boolean;
  chat_path?: string | null;
  last_active_path?: string | null;
  source?: WorkspaceSource;
};

export type WorkspaceUpdatePatch = Partial<{
  root_path: string;
  theme: Partial<WorkspaceTheme>;
  pinned: boolean;
  chat_path: string | null;
  last_used_at: number | null;
  last_active_path: string | null;
  source: WorkspaceSource;
}>;

export type ProjectWorkspaceState = {
  loading: boolean;
  records: WorkspaceRecord[];
  selection: WorkspaceSelection;
  current: WorkspaceRecord | null;
  filterPaths: (paths: readonly string[]) => string[];
  matchesPath: (path: string) => boolean;
  resolveWorkspaceForPath: (path: string) => WorkspaceRecord | null;
  setSelection: (selection: WorkspaceSelection) => void;
  createWorkspace: (input: WorkspaceCreateInput) => WorkspaceRecord;
  updateWorkspace: (
    workspace_id: string,
    patch: WorkspaceUpdatePatch,
  ) => WorkspaceRecord | null;
  deleteWorkspace: (workspace_id: string) => void;
  touchWorkspace: (workspace_id: string) => void;
};
