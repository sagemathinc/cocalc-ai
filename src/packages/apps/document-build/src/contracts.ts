/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type DocumentKind = "latex" | "knitr" | "r-markdown" | "quarto";

export type DocumentBuildState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "timed_out";

export type BuildStageState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "timed_out";

export interface BuildDocumentIdentity {
  kind: DocumentKind;
  logical_path: string;
  working_path: string;
  resource_key: string;
}

export interface SavedBuildConfig {
  build_command?: string | string[];
}

export interface DocumentBuildRequest {
  path: string;
  build_id?: string;
  request_id?: string;
  generation?: string;
  expected_source_hash?: number;
  force?: boolean;
  build_timeout_ms?: number;
  output_directory?: string | null;
  submitted_at?: number;
}

export interface BuildResourceStat {
  timestamp?: number;
  cpu_pct?: number;
  mem_rss?: number;
  [key: string]: string | number | boolean | null | undefined;
}

export interface BuildStageSpec {
  stage_id: string;
  name:
    | "knitr"
    | "latex"
    | "patch-synctex"
    | "sagetex"
    | "pythontex"
    | "r-markdown"
    | "quarto";
  logical_path: string;
  working_path: string;
  resource_key: string;
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  bash: boolean;
  timeout_s: number;
  required: boolean;
  job_key: string;
  aggregate_key?: string | number;
}

export interface BuildStageResult extends BuildStageSpec {
  state: BuildStageState;
  started_at?: number;
  ended_at?: number;
  exit_code?: number;
  stdout: string;
  stderr: string;
  job_id?: string;
  error?: string;
  stats?: BuildResourceStat[];
}

export interface BuildStageEvent {
  type: "started" | "updated" | "finished";
  stage: BuildStageResult;
}

export interface BuildDiagnostic {
  level: "error" | "warning" | "typesetting";
  source:
    | "configuration"
    | "transport"
    | "latex"
    | "knitr"
    | "sagetex"
    | "pythontex"
    | "r-markdown"
    | "quarto";
  message: string;
  file?: string;
  line?: number;
  end_line?: number;
  content?: string;
  raw?: string;
  stage_id?: string;
}

export interface BuildArtifact {
  path: string;
  type: "pdf" | "html" | "notebook-html" | "tex";
}

export interface DocumentBuildSnapshot {
  build_id: string;
  request_id?: string;
  generation?: string;
  identity: BuildDocumentIdentity;
  state: DocumentBuildState;
  seq: number;
  submitted_at: number;
  started_at?: number;
  ended_at?: number;
  build_timeout_ms: number;
  deadline_at?: number;
  force: boolean;
  stages: BuildStageResult[];
  diagnostics: BuildDiagnostic[];
  dependencies: string[];
  artifacts: BuildArtifact[];
  exit_code?: number;
  error?: string;
}

export interface DocumentBuildCapabilities {
  kinds: Array<{
    kind: DocumentKind;
    extensions: string[];
  }>;
  extensions: string[];
  supports_cancel: boolean;
  supports_build_timeout: boolean;
}

export interface DocumentBuildCallbacks {
  onSnapshot?: (snapshot: DocumentBuildSnapshot) => void;
  onStage?: (event: BuildStageEvent) => void;
}

export interface DocumentBuildRuntime {
  readText(path: string): Promise<string>;
  readBuildConfig(path: string): Promise<SavedBuildConfig | undefined>;
  exists(path: string): Promise<boolean>;
  // Rejects with an error whose `code` is "ENOENT" when the file is absent;
  // every other failure (permissions, I/O) rejects with its own error, so
  // callers can distinguish "not there" from "could not be read".
  hash(path: string): Promise<string>;
  execute(
    stage: BuildStageSpec,
    onEvent: (event: BuildStageEvent) => void,
  ): Promise<BuildStageResult>;
  copy(source: string, destination: string): Promise<void>;
  now?(): number;
}

export interface DocumentBuildDefinition {
  kind: DocumentKind;
  extensions: readonly string[];
  resolveIdentity(path: string): BuildDocumentIdentity;
  run(
    request: DocumentBuildRequest,
    runtime: DocumentBuildRuntime,
    callbacks?: DocumentBuildCallbacks,
  ): Promise<DocumentBuildSnapshot>;
}
