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
