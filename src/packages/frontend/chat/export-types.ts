export type ChatExportScope =
  | "current-thread"
  | "all-non-archived-threads"
  | "all-threads";

export interface ChatExportOpenRequest {
  scope?: ChatExportScope;
  threadKey?: string | null;
  label?: string;
}

export interface ChatArchiveExportOptions {
  scope: ChatExportScope;
  threadId?: string;
  outputPath: string;
  includeBlobs?: boolean;
  includeCodexContext?: boolean;
}

export interface ChatArchiveImportOptions {
  file: File;
}

export interface ChatArchiveImportResult {
  target_path: string;
  created_thread_count: number;
  created_message_count: number;
  asset_count: number;
  codex_context_count: number;
  warning_count: number;
  warnings?: Array<{
    code?: string;
    thread_id?: string;
    message?: string;
  }>;
  thread_ids?: string[];
}
