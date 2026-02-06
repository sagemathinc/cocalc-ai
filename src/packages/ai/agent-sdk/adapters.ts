/*
Adapter contracts for wiring agent-sdk capabilities to real CoCalc APIs.
*/

import type { CreateProjectOptions } from "@cocalc/util/db-schema/projects";
import type { Customize } from "@cocalc/util/db-schema/server-settings";
import type { DirectoryListingEntry } from "@cocalc/util/types";

type Awaitable<T> = T | Promise<T>;

export type AgentHubAdapter = {
  ping: () => Awaitable<{ now: number }>;
  getCustomize: (fields?: string[]) => Awaitable<Customize>;
  createProject: (opts: CreateProjectOptions) => Awaitable<string>;
};

export type AgentProjectAppsAdapter = {
  start: (name: string) => Awaitable<unknown>;
  stop: (name: string) => Awaitable<void>;
  status: (name: string) => Awaitable<unknown>;
};

export type AgentProjectAdapter = {
  listing: (opts: {
    path: string;
    hidden?: boolean;
  }) => Awaitable<DirectoryListingEntry[]>;
  writeTextFileToProject: (opts: {
    path: string;
    content: string;
  }) => Awaitable<void>;
  apps: AgentProjectAppsAdapter;
};

export type AgentUIAdapter = {
  openFile?: (opts: { projectId: string; path: string }) => Awaitable<void>;
};

export type AgentSdkAdapters = {
  hub?: AgentHubAdapter;
  project?: AgentProjectAdapter;
  ui?: AgentUIAdapter;
};

export type AgentSdkContext = {
  adapters: AgentSdkAdapters;
  defaults?: {
    projectId?: string;
    accountId?: string;
  };
};

export function requireHubAdapter(context: AgentSdkContext): AgentHubAdapter {
  const hub = context.adapters.hub;
  if (!hub) {
    throw new Error("Hub adapter is not configured");
  }
  return hub;
}

export function requireProjectAdapter(
  context: AgentSdkContext,
): AgentProjectAdapter {
  const project = context.adapters.project;
  if (!project) {
    throw new Error("Project adapter is not configured");
  }
  return project;
}
