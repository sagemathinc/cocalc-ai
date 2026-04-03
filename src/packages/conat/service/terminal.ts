/*
Service for controlling a terminal served from a project.
*/

import {
  createServiceClient,
  createServiceHandler,
  type ConatService,
} from "./typed";
import type { Client } from "@cocalc/conat/core/client";

export type { ConatService };

export const SIZE_TIMEOUT_MS = 45000;

function requireClient(client: Client | undefined): Client {
  if (client == null) {
    throw Error(
      "terminal service helper must provide an explicit Conat client",
    );
  }
  return client;
}

// API that runs under Node.js in linux:

interface TerminalApi {
  create: (opts: {
    env?: { [key: string]: string };
    command?: string;
    args?: string[];
    cwd?: string;
    ephemeral?: boolean;
  }) => Promise<{ success: "ok"; note?: string; ephemeral?: boolean }>;

  write: (data: string) => Promise<void>;

  restart: () => Promise<void>;

  cwd: () => Promise<string | undefined>;

  kill: () => Promise<void>;

  size: (opts: {
    rows: number;
    cols: number;
    browser_id: string;
    kick?: boolean;
  }) => Promise<void>;

  // sent from browser to project when this client is leaving.
  close: (browser_id: string) => Promise<void>;
}

export function createTerminalClient({
  project_id,
  termPath,
  client,
}: {
  project_id: string;
  termPath: string;
  client: Client;
}) {
  return createServiceClient<TerminalApi>({
    client: requireClient(client),
    project_id,
    path: termPath,
    service: "terminal-server",
    timeout: 3000,
  });
}

export type TerminalServiceApi = ReturnType<typeof createTerminalClient>;

export function createTerminalServer({
  project_id,
  termPath,
  impl,
  client,
}: {
  project_id: string;
  termPath: string;
  impl;
  client: Client;
}): ConatService {
  return createServiceHandler<TerminalApi>({
    client: requireClient(client),
    project_id,
    path: termPath,
    service: "terminal-server",
    description: "Terminal service.",
    impl,
  });
}

// API that runs in the browser:

export interface TerminalBrowserApi {
  // command is used for things like "open foo.txt" in the terminal.
  command: (mesg) => Promise<void>;

  // used for kicking all but the specified user out:
  kick: (sender_browser_id: string) => Promise<void>;

  // tell browser to change its size
  size: (opts: { rows: number; cols: number }) => Promise<void>;
}

export function createBrowserClient({
  project_id,
  termPath,
  client,
}: {
  project_id: string;
  termPath: string;
  client: Client;
}) {
  return createServiceClient<TerminalBrowserApi>({
    client: requireClient(client),
    project_id,
    path: termPath,
    service: "terminal-browser",
  });
}

export function createBrowserService({
  project_id,
  termPath,
  impl,
  client,
}: {
  project_id: string;
  termPath: string;
  impl: TerminalBrowserApi;
  client: Client;
}): ConatService {
  return createServiceHandler<TerminalBrowserApi>({
    client: requireClient(client),
    project_id,
    path: termPath,
    service: "terminal-browser",
    description: "Browser Terminal service.",
    all: true,
    impl,
  });
}
