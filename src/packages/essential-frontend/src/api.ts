/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { authBootstrapUrl } from "./urls";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";

export interface ProjectWindowRequest {
  limit?: number;
  offset?: number;
  project_id?: string;
  search?: string;
}

export interface AuthBootstrap {
  signed_in: boolean;
  account_id?: string;
  display_name?: string;
  email_address?: string;
  home_bay_id?: string;
  home_bay_url?: string;
  project_window?: AccountProjectListWindowRow[];
  project_window_has_more?: boolean;
}

async function requestBootstrap({
  origin,
  projectWindow,
  signal,
}: {
  origin?: string;
  projectWindow?: ProjectWindowRequest;
  signal?: AbortSignal;
}): Promise<AuthBootstrap> {
  const endpoint = origin
    ? new URL(authBootstrapUrl(), origin).toString()
    : authBootstrapUrl();
  const response = await fetch(endpoint, {
    method: "POST",
    body: JSON.stringify(
      projectWindow ? { project_window: projectWindow } : {},
    ),
    credentials: origin ? "include" : "same-origin",
    headers: { "Content-Type": "application/json" },
    signal,
  });
  const text = await response.text();
  let value: AuthBootstrap & { error?: string };
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Authentication returned HTTP ${response.status}.`);
  }
  if (!response.ok || value.error) {
    throw new Error(
      value.error || `Authentication returned HTTP ${response.status}.`,
    );
  }
  return value;
}

export async function getAuthBootstrap(
  signal?: AbortSignal,
): Promise<AuthBootstrap> {
  const projectWindow = { limit: 50 };
  const bootstrap = await requestBootstrap({ projectWindow, signal });
  if (
    !bootstrap.signed_in ||
    bootstrap.project_window != null ||
    !bootstrap.home_bay_url
  ) {
    return bootstrap;
  }
  const homeBootstrap = await requestBootstrap({
    origin: bootstrap.home_bay_url,
    projectWindow,
    signal,
  });
  if (
    !homeBootstrap.signed_in ||
    homeBootstrap.account_id !== bootstrap.account_id ||
    homeBootstrap.project_window == null
  ) {
    throw new Error("Your home bay did not return the project list.");
  }
  return homeBootstrap;
}

export async function getAccountProjectWindow({
  bootstrap,
  request,
  signal,
}: {
  bootstrap: AuthBootstrap;
  request: ProjectWindowRequest;
  signal?: AbortSignal;
}): Promise<{
  hasMore: boolean;
  projects: AccountProjectListWindowRow[];
}> {
  if (!bootstrap.home_bay_url) {
    throw new Error("The signed-in account has no home bay route.");
  }
  const value = await requestBootstrap({
    origin: bootstrap.home_bay_url,
    projectWindow: request,
    signal,
  });
  if (
    !value.signed_in ||
    value.account_id !== bootstrap.account_id ||
    value.project_window == null
  ) {
    throw new Error("Your home bay did not return the project list.");
  }
  return {
    hasMore: value.project_window_has_more === true,
    projects: value.project_window,
  };
}
