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

export type BrowserExecPolicyV1 = {
  version: 1;
  // Explicitly allow raw JS execution in prod posture.
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
