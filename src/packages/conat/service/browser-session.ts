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
  }) => Promise<{ ok: true; result: unknown }>;
  startExec: (opts: {
    project_id: string;
    code: string;
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
