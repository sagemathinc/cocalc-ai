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
  status:
    | "running"
    | "waiting_decision"
    | "scheduled"
    | "paused"
    | "stopped";
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

export interface AcpChatContext {
  project_id: string;
  path: string;
  message_date: string;
  sender_id: string;
  // Browser-visible API origin for this chat turn (e.g. https://host:port).
  api_url?: string;
  // Browser session initiating this turn (for agent/browser automation routing).
  browser_id?: string;
  reply_to?: string;
  // Schema-v2 identities for robust row targeting.
  message_id?: string;
  thread_id?: string;
  reply_to_message_id?: string;
  // Marks that this user message was sent via "Send Immediately" while an ACP
  // turn was active, so the backend can preserve continue semantics.
  send_mode?: "immediate";
  // Optional loop automation config attached to a turn kickoff request.
  loop_config?: AcpLoopConfig;
  // Optional loop runtime snapshot from backend state machine.
  loop_state?: AcpLoopState;
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
  | { type: "status"; state: "init" | "running" }
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

export type AcpStreamMessage = AcpStreamPayload & { seq: number };
