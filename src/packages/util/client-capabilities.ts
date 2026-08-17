/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

export interface ClientProtocolCapabilities {
  protocol_version: 1;
  app_base_path: string;
  browser_challenge_login: 1;
  project_window: 1;
  project_host_routing: 1;
  chat_sync: 2;
  agent_session_index: 1;
  acp: 1;
  auth_callback?: 1;
}

export function clientProtocolCapabilities(
  appBasePath: string,
): ClientProtocolCapabilities {
  const normalized =
    appBasePath === "/"
      ? ""
      : `/${appBasePath.split("/").filter(Boolean).join("/")}`;
  return {
    protocol_version: 1,
    app_base_path: normalized,
    browser_challenge_login: 1,
    project_window: 1,
    project_host_routing: 1,
    chat_sync: 2,
    agent_session_index: 1,
    acp: 1,
  };
}
