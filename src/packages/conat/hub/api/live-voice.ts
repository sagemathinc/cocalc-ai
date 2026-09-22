/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
export interface LiveVoiceRequest {
  account_id?: string;
  project_id: string;
  action: "capabilities" | "start" | "heartbeat" | "end";
  request_id?: string;
  session_id?: string;
  sdp?: string;
  history?: { role: "user" | "assistant"; text: string }[];
}
export interface LiveVoiceResult {
  enabled: boolean;
  reason?: string;
  session_id?: string;
  sdp?: string;
  expires_at?: number;
  max_seconds: number;
  usd_per_minute: number;
  funding_source?: "account" | "project";
}
