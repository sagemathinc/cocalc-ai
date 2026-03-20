import type { CodexSessionConfig } from "@cocalc/util/ai/codex";
import type { LineDiffResult } from "@cocalc/util/line-diff";

export type AcpLoopStopReason =
  | "completed"
  | "max_turns"
  | "max_wall_time"
  | "needs_human"
  | "missing_contract"
  | "invalid_contract"
  | "repeated_blocker"
  | "user_stopped"
  | "backend_error";

export interface AcpLoopConfig {
  // Explicit on/off switch for loop behavior.
  enabled: boolean;
  // Hard cap on number of ACP iterations in this loop run.
  max_turns?: number;
  // Hard cap on total wall time for this loop run.
  max_wall_time_ms?: number;
  // Optional pause cadence for human check-in.
  check_in_every_turns?: number;
  // Stop after this many repeated blocker signatures.
  stop_on_repeated_blocker_count?: number;
  // Optional delay between iterations.
  sleep_ms_between_turns?: number;
}

export interface AcpLoopState {
  loop_id: string;
  status: "running" | "waiting_decision" | "scheduled" | "paused" | "stopped";
  started_at_ms: number;
  updated_at_ms: number;
  iteration: number;
  max_turns?: number;
  max_wall_time_ms?: number;
  next_prompt?: string;
  last_blocker_signature?: string;
  repeated_blocker_count?: number;
  stop_reason?: AcpLoopStopReason;
}

export interface AcpLoopContractDecision {
  rerun: boolean;
  needs_human: boolean;
  next_prompt?: string;
  blocker?: string;
  confidence?: number;
  sleep_sec?: number;
}

export interface AcpAutomationConfig {
  enabled?: boolean;
  automation_id?: string;
  title?: string;
  prompt?: string;
  schedule_type?: "daily";
  local_time?: string;
  timezone?: string;
  pause_after_unacknowledged_runs?: number;
}

export interface AcpAutomationState {
  automation_id?: string;
  status?: "active" | "running" | "paused" | "error";
  next_run_at_ms?: number;
  last_run_started_at_ms?: number;
  last_run_finished_at_ms?: number;
  last_acknowledged_at_ms?: number;
  unacknowledged_runs?: number;
  paused_reason?: string;
  last_error?: string;
  last_job_op_id?: string;
  last_message_id?: string;
}

export interface AcpAutomationRecord {
  automation_id: string;
  project_id: string;
  path: string;
  thread_id: string;
  account_id?: string;
  title?: string;
  prompt?: string;
  schedule_type?: "daily";
  local_time?: string;
  timezone?: string;
  pause_after_unacknowledged_runs?: number;
  status?: "active" | "running" | "paused" | "error";
  enabled?: boolean;
  next_run_at_ms?: number;
  last_run_started_at_ms?: number;
  last_run_finished_at_ms?: number;
  last_acknowledged_at_ms?: number;
  unacknowledged_runs?: number;
  paused_reason?: string;
  last_error?: string;
  last_job_op_id?: string;
  last_message_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface AcpChatContext {
  project_id: string;
  path: string;
  message_date: string;
  sender_id: string;
  user_message_date?: string;
  user_message_content?: string;
  user_parent_message_id?: string;
  started_at_ms?: number;
  // Browser-visible API origin for this chat turn (e.g. https://host:port).
  api_url?: string;
  // Browser session initiating this turn (for agent/browser automation routing).
  browser_id?: string;
  // Schema-v2 identities for robust row targeting.
  message_id?: string;
  thread_id?: string;
  parent_message_id?: string;
  // Marks that this user message was sent via "Send Immediately" while an ACP
  // turn was active, so the backend can preserve continue semantics.
  send_mode?: "immediate";
  // Optional loop automation config attached to a turn kickoff request.
  loop_config?: AcpLoopConfig;
  // Optional loop runtime snapshot from backend state machine.
  loop_state?: AcpLoopState;
  // Optional scheduled automation identity when this turn is due to an
  // automation attached to the thread.
  automation_id?: string;
  automation_title?: string;
}

export type AcpRequest = {
  project_id: string;
  account_id: string;
  prompt: string;
  session_id?: string;
  config?: CodexSessionConfig;
  runtime_env?: Record<string, string>;
  chat?: AcpChatContext;
};

export type AcpInterruptRequest = {
  project_id: string;
  account_id: string;
  threadId?: string;
  chat?: AcpChatContext;
  note?: string;
};

export type AcpForkSessionRequest = {
  project_id: string;
  account_id: string;
  sessionId: string;
  newSessionId?: string;
};

export type AcpControlRequest = {
  project_id: string;
  account_id: string;
  path: string;
  thread_id: string;
  user_message_id: string;
  action: "cancel" | "send_immediately";
};

export type AcpControlResponse = {
  ok: boolean;
  state?:
    | "queued"
    | "running"
    | "completed"
    | "error"
    | "canceled"
    | "interrupted"
    | "missing";
};

export type AcpAutomationRequest = {
  project_id: string;
  account_id: string;
  path: string;
  thread_id: string;
  action: "upsert" | "pause" | "resume" | "run_now" | "acknowledge" | "delete";
  config?: AcpAutomationConfig | null;
};

export type AcpAutomationResponse = {
  ok: boolean;
  config?: AcpAutomationConfig | null;
  state?: AcpAutomationState | null;
  record?: AcpAutomationRecord | null;
};

export type AcpStreamUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
  model_context_window?: number;
};

export type AcpStreamEvent =
  | {
      type: "thinking";
      text: string;
    }
  | {
      type: "message";
      text: string;
      delta?: boolean;
    }
  | {
      type: "diff";
      path: string;
      diff: LineDiffResult;
    }
  | {
      type: "file";
      path: string;
      operation: "read" | "write";
      cwd?: string;
      command?: string;
      args?: string[];
      bytes?: number;
      // True only when producer knows this is an exact byte count for the
      // operation itself (not a heuristic such as resulting file size).
      bytes_known?: boolean;
      truncated?: boolean;
      line?: number;
      limit?: number;
      existed?: boolean;
    }
  | {
      type: "terminal";
      terminalId: string;
      phase: "start" | "data" | "exit";
      command?: string;
      args?: string[];
      cwd?: string;
      chunk?: string;
      truncated?: boolean;
      exitStatus?: {
        exitCode?: number;
        signal?: string;
      };
      output?: string;
    };

export type AcpStreamPayload =
  | {
      type: "status";
      state: "init" | "queued" | "running";
      threadId?: string | null;
    }
  | {
      type: "event";
      event: AcpStreamEvent;
    }
  | {
      type: "usage";
      usage: AcpStreamUsage;
    }
  | {
      type: "summary";
      finalResponse: string;
      usage?: AcpStreamUsage | null;
      threadId?: string | null;
    }
  | {
      type: "error";
      error: string;
    };

export type AcpStreamMessage = AcpStreamPayload & {
  seq: number;
  // Wall-clock time when the event was recorded by CoCalc. Persisted so log
  // rows can keep stable timestamps after reload instead of only during the
  // live subscription window.
  time?: number;
};
