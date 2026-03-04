/*
Browser session service API.

This is an account+browser scoped conat service used by CLI/agents to query
and drive one specific signed-in browser tab session.
*/

import { createServiceClient, createServiceHandler } from "./typed";
import type { ConatService } from "./typed";
import type { Client } from "@cocalc/conat/core/client";
import type { BrowserOpenProjectState } from "@cocalc/conat/hub/api/system";

export type BrowserOpenFileInfo = {
  project_id: string;
  title?: string;
  // Absolute path.
  path: string;
};

export type BrowserExecStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type BrowserExecOperation = {
  exec_id: string;
  project_id: string;
  status: BrowserExecStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  cancel_requested?: boolean;
  error?: string;
  result?: unknown;
};

export type BrowserAutomationPosture = "dev" | "prod";

export type BrowserActionName =
  | "click"
  | "click_at"
  | "drag"
  | "type"
  | "press"
  | "reload"
  | "navigate"
  | "scroll_by"
  | "scroll_to"
  | "wait_for_selector"
  | "wait_for_url"
  | "batch";

export type BrowserCoordinateSpace =
  | "viewport"
  | "selector"
  | "image"
  | "normalized";

export type BrowserScreenshotMetadata = {
  page_url?: string;
  captured_at?: string;
  selector?: string;
  image_width?: number;
  image_height?: number;
  capture_scale?: number;
  device_pixel_ratio?: number;
  scroll_x?: number;
  scroll_y?: number;
  selector_rect_css?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  viewport_css?: {
    width: number;
    height: number;
  };
};

export type BrowserActionRequest =
  | BrowserAtomicActionRequest
  | {
      name: "batch";
      actions: BrowserAtomicActionRequest[];
      continue_on_error?: boolean;
    };

export type BrowserAtomicActionRequest =
  | {
      name: "click";
      selector: string;
      button?: "left" | "middle" | "right";
      click_count?: number;
      timeout_ms?: number;
      wait_for_navigation_ms?: number;
    }
  | {
      name: "click_at";
      x: number;
      y: number;
      space?: BrowserCoordinateSpace;
      selector?: string;
      button?: "left" | "middle" | "right";
      click_count?: number;
      timeout_ms?: number;
      wait_for_navigation_ms?: number;
      screenshot_meta?: BrowserScreenshotMetadata;
      strict_meta?: boolean;
    }
  | {
      name: "drag";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      space?: BrowserCoordinateSpace;
      selector?: string;
      button?: "left" | "middle" | "right";
      steps?: number;
      hold_ms?: number;
      timeout_ms?: number;
      screenshot_meta?: BrowserScreenshotMetadata;
      strict_meta?: boolean;
    }
  | {
      name: "type";
      selector: string;
      text: string;
      append?: boolean;
      clear?: boolean;
      submit?: boolean;
      timeout_ms?: number;
    }
  | {
      name: "press";
      key: string;
      selector?: string;
      ctrl?: boolean;
      alt?: boolean;
      shift?: boolean;
      meta?: boolean;
      timeout_ms?: number;
    }
  | {
      name: "reload";
      // Best-effort hard reload request. Browser behavior may vary.
      hard?: boolean;
    }
  | {
      name: "navigate";
      url: string;
      wait_for_url_ms?: number;
      replace?: boolean;
    }
  | {
      name: "scroll_by";
      dx?: number;
      dy?: number;
      behavior?: "auto" | "smooth";
    }
  | {
      name: "scroll_to";
      selector?: string;
      top?: number;
      left?: number;
      behavior?: "auto" | "smooth";
      block?: "start" | "center" | "end" | "nearest";
      inline?: "start" | "center" | "end" | "nearest";
      timeout_ms?: number;
      poll_ms?: number;
    }
  | {
      name: "wait_for_selector";
      selector: string;
      state?: "attached" | "visible" | "hidden" | "detached";
      timeout_ms?: number;
      poll_ms?: number;
    }
  | {
      name: "wait_for_url";
      url?: string;
      includes?: string;
      regex?: string;
      timeout_ms?: number;
      poll_ms?: number;
    };

export type BrowserActionResult = {
  name: BrowserActionName;
  ok: true;
  page_url?: string;
  elapsed_ms?: number;
  [key: string]: unknown;
};

export type BrowserRuntimeEventKind =
  | "console"
  | "uncaught_error"
  | "unhandled_rejection";

export type BrowserRuntimeEventLevel =
  | "trace"
  | "debug"
  | "log"
  | "info"
  | "warn"
  | "error";

export type BrowserRuntimeEvent = {
  seq: number;
  ts: string;
  kind: BrowserRuntimeEventKind;
  level: BrowserRuntimeEventLevel;
  message: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
  url?: string;
};

export type BrowserNetworkTraceProtocol = "conat" | "http" | "ws";

export type BrowserNetworkTraceDirection = "send" | "recv";

export type BrowserNetworkTracePhase =
  | "publish_chunk"
  | "recv_chunk"
  | "recv_message"
  | "drop_chunk_seq"
  | "drop_chunk_timeout"
  | "http_request"
  | "http_response"
  | "http_error"
  | "ws_open"
  | "ws_send"
  | "ws_message"
  | "ws_close"
  | "ws_error";

export type BrowserNetworkTraceEvent = {
  seq: number;
  ts: string;
  protocol: BrowserNetworkTraceProtocol;
  direction: BrowserNetworkTraceDirection;
  phase: BrowserNetworkTracePhase;
  client_id?: string;
  address?: string;
  subject?: string;
  chunk_id?: string;
  chunk_seq?: number;
  chunk_done?: boolean;
  chunk_bytes?: number;
  raw_bytes?: number;
  encoding?: number;
  headers?: Record<string, unknown>;
  decoded_preview?: string;
  decode_error?: string;
  message?: string;
  target_url?: string;
  method?: string;
  status?: number;
  duration_ms?: number;
  url?: string;
};

export type BrowserExecPolicyV1 = {
  version: 1;
  // In prod posture, raw JS execution is disabled by default and exec runs in
  // a constrained sandbox mode. Set this to true to permit raw JS evaluation.
  allow_raw_exec?: boolean;
  // Optional hard scope for project/workspace ids.
  allowed_project_ids?: string[];
  // Optional hard scope for browser location.origin values.
  allowed_origins?: string[];
  // Optional allow-list for typed action names.
  allowed_actions?: BrowserActionName[];
};

export interface BrowserSessionServiceApi {
  getExecApiDeclaration: () => Promise<string>;
  getSessionInfo: () => Promise<{
    browser_id: string;
    session_name?: string;
    url?: string;
    active_project_id?: string;
    open_projects: BrowserOpenProjectState[];
  }>;
  configureNetworkTrace: (opts?: {
    enabled?: boolean;
    include_decoded?: boolean;
    include_internal?: boolean;
    protocols?: BrowserNetworkTraceProtocol[];
    max_events?: number;
    max_preview_chars?: number;
    subject_prefixes?: string[];
    addresses?: string[];
  }) => Promise<{
    enabled: boolean;
    include_decoded: boolean;
    include_internal: boolean;
    protocols: BrowserNetworkTraceProtocol[];
    max_events: number;
    max_preview_chars: number;
    subject_prefixes: string[];
    addresses: string[];
    buffered: number;
    dropped: number;
    next_seq: number;
  }>;
  listNetworkTrace: (opts?: {
    after_seq?: number;
    limit?: number;
    protocol?: BrowserNetworkTraceProtocol;
    protocols?: BrowserNetworkTraceProtocol[];
    direction?: BrowserNetworkTraceDirection;
    phases?: BrowserNetworkTracePhase[];
    subject_prefix?: string;
    address?: string;
    include_decoded?: boolean;
  }) => Promise<{
    events: BrowserNetworkTraceEvent[];
    next_seq: number;
    dropped: number;
    total_buffered: number;
  }>;
  clearNetworkTrace: () => Promise<{ ok: true; cleared: number; next_seq: number }>;
  listRuntimeEvents: (opts?: {
    after_seq?: number;
    limit?: number;
    kinds?: BrowserRuntimeEventKind[];
    levels?: BrowserRuntimeEventLevel[];
  }) => Promise<{
    events: BrowserRuntimeEvent[];
    next_seq: number;
    dropped: number;
    total_buffered: number;
  }>;
  listOpenFiles: () => Promise<BrowserOpenFileInfo[]>;
  openFile: (opts: {
    project_id: string;
    path: string;
    foreground?: boolean;
    foreground_project?: boolean;
  }) => Promise<{ ok: true }>;
  closeFile: (opts: {
    project_id: string;
    path: string;
  }) => Promise<{ ok: true }>;
  exec: (opts: {
    project_id: string;
    code: string;
    posture?: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }) => Promise<{ ok: true; result: unknown }>;
  action: (opts: {
    project_id: string;
    action: BrowserActionRequest;
    posture?: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }) => Promise<{ ok: true; result: BrowserActionResult }>;
  startExec: (opts: {
    project_id: string;
    code: string;
    posture?: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }) => Promise<{ exec_id: string; status: BrowserExecStatus }>;
  getExec: (opts: {
    exec_id: string;
  }) => Promise<BrowserExecOperation>;
  cancelExec: (opts: {
    exec_id: string;
  }) => Promise<{ ok: true; exec_id: string; status: BrowserExecStatus }>;
}

const SERVICE = "browser-session";

export function createBrowserSessionClient({
  account_id,
  browser_id,
  client,
  timeout,
}: {
  account_id: string;
  browser_id: string;
  client?: Client;
  timeout?: number;
}) {
  return createServiceClient<BrowserSessionServiceApi>({
    account_id,
    browser_id,
    service: SERVICE,
    client,
    timeout,
  });
}

export function createBrowserSessionService({
  account_id,
  browser_id,
  impl,
  client,
}: {
  account_id: string;
  browser_id: string;
  impl: BrowserSessionServiceApi;
  client?: Client;
}): ConatService {
  return createServiceHandler<BrowserSessionServiceApi>({
    account_id,
    browser_id,
    service: SERVICE,
    description: "Browser session automation service.",
    impl,
    client,
  });
}
