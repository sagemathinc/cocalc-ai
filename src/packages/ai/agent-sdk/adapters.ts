/*
Adapter contracts for wiring agent-sdk capabilities to real CoCalc APIs.
*/

import type { HubApi } from "@cocalc/conat/hub/api";
import type { ProjectApi } from "@cocalc/conat/project/api";
import type { CreateProjectOptions } from "@cocalc/util/db-schema/projects";
import type { Customize } from "@cocalc/util/db-schema/server-settings";
import type { DirectoryListingEntry } from "@cocalc/util/types";

export type AgentHubAdapter = {
  ping: HubApi["system"]["ping"];
  getCustomize: (fields?: string[]) => Promise<Customize>;
  createProject: (opts: CreateProjectOptions) => Promise<string>;
};

export type AgentProjectAppsAdapter = {
  start: ProjectApi["apps"]["start"];
  stop: ProjectApi["apps"]["stop"];
  status: ProjectApi["apps"]["status"];
};

export type AgentProjectAdapter = {
  listing: (opts: {
    path: string;
    hidden?: boolean;
  }) => Promise<DirectoryListingEntry[]>;
  writeTextFileToProject: (opts: {
    path: string;
    content: string;
  }) => Promise<void>;
  apps: AgentProjectAppsAdapter;
};

export type AgentUIAdapter = {
  openFile?: (opts: { projectId: string; path: string }) => Promise<void>;
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

