/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import {
  RestrictedEgressProxy,
  type RestrictedEgressProxySession,
} from "../restricted-egress-proxy";

// Keep this deliberately narrow. This proxy exists only so Codex authentication
// and provider traffic continue to work when general project egress is disabled.
const ALLOWED_OPENAI_HOSTS = new Set([
  "api.openai.com",
  "auth.openai.com",
  "chat.openai.com",
  "chatgpt.com",
  "files.openai.com",
]);

export type RestrictedCodexEgressProxySession = RestrictedEgressProxySession;

const proxy = new RestrictedEgressProxy({
  name: "Codex",
  username: "cocalc-codex",
  allowedHosts: ALLOWED_OPENAI_HOSTS,
});

export function isAllowedCodexEgressTarget(rawTarget: string): boolean {
  return proxy.isAllowedTarget(rawTarget);
}

export function startRestrictedCodexEgressProxySession(): Promise<RestrictedCodexEgressProxySession> {
  return proxy.startSession();
}

export function shutdownRestrictedCodexEgressProxyForTesting(): Promise<void> {
  return proxy.shutdown();
}
