/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { ChatThreadRuntimeState, CodexThreadConfig } from "@cocalc/chat";
import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";

export type { CodexThreadConfig } from "@cocalc/chat";

export type ChatConnectionState =
  | "closed"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type ChatMessageRole = "human" | "agent" | "system";

export interface ProjectedChatMessage {
  message_id: string;
  thread_id: string;
  parent_message_id?: string;
  sender_id: string;
  role: ChatMessageRole;
  content: string;
  date: string;
  revision_date?: string;
  generating: boolean;
  guidance?: boolean;
  guidance_delivered_at_ms?: number;
  state?:
    | "sending"
    | "sent"
    | "queued"
    | "running"
    | "interrupted"
    | "complete"
    | "error";
  acp_events?: unknown[];
  acp_log_store?: string;
  acp_log_key?: string;
  acp_live_log_stream?: string;
  acp_live_preview_stream?: string;
  activity?: {
    state: "loading" | "ready" | "error";
    source?: "live-preview" | "recovered";
    events: AcpStreamMessage[];
    markdown?: string;
    error?: string;
  };
}

export interface ProjectedChatThread {
  thread_id: string;
  root_message_id?: string;
  name?: string;
  agent_kind?: "acp" | "llm" | "none";
  agent_model?: string;
  acp_config?: CodexThreadConfig;
  state: ChatThreadRuntimeState;
  active_message_id?: string;
  updated_at?: string;
}

export interface ChatSnapshot {
  revision: number;
  connection: ChatConnectionState;
  ready: boolean;
  error?: string;
  project_id: string;
  path: string;
  selected_thread_id?: string;
  threads: ProjectedChatThread[];
  messages: ProjectedChatMessage[];
  message_window?: {
    limit: number;
    loaded: number;
    has_older: boolean;
    omitted: number;
  };
}

export interface HeadlessChatClient {
  open(): Promise<void>;
  getSnapshot(): ChatSnapshot;
  subscribe(listener: (snapshot: ChatSnapshot) => void): () => void;
  selectThread(thread_id: string): void;
  createCodexThread(opts: {
    thread_id: string;
    name?: string;
    acp_config: CodexThreadConfig;
  }): Promise<{ thread_id: string }>;
  sendToExistingCodexThread(opts: {
    thread_id: string;
    text: string;
  }): Promise<{ message_id: string; thread_id: string }>;
  sendGuidanceToCodexThread(opts: {
    thread_id: string;
    text: string;
  }): Promise<{ message_id: string; thread_id: string }>;
  updateCodexThreadConfig(opts: {
    thread_id: string;
    acp_config: CodexThreadConfig;
  }): Promise<void>;
  interrupt(thread_id: string): Promise<void>;
  loadOlderMessages?(limit: number): Promise<void>;
  reconnect(reason: string): Promise<void>;
  close(): Promise<void>;
}
