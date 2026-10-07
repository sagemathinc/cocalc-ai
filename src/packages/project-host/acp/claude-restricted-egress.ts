/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { projectNetworkPolicyFromRunQuota } from "../network-policy-quota";
import {
  RestrictedEgressProxy,
  type RestrictedEgressProxySession,
} from "../restricted-egress-proxy";
import { getProject } from "../sqlite/projects";

// Hosts Claude Code needs for model traffic and subscription (OAuth) access,
// taken from Claude Code 2.1.x: the Messages API and OAuth profile/usage
// (api.anthropic.com), OAuth token refresh (platform.claude.com), sign-in client
// metadata (claude.ai). Only connector-enabled subscription sessions also get
// the claude.ai connector endpoint (mcp-proxy.anthropic.com).
// Telemetry, error reporting and self-update hosts are deliberately absent;
// Claude Code treats those failures as non-fatal.
const ALLOWED_ANTHROPIC_HOSTS = new Set([
  "api.anthropic.com",
  "platform.claude.com",
  "claude.ai",
]);
const CONNECTOR_HOST = "mcp-proxy.anthropic.com";
const CONNECTOR_HOSTS = new Set([...ALLOWED_ANTHROPIC_HOSTS, CONNECTOR_HOST]);

const proxy = new RestrictedEgressProxy({
  name: "Claude",
  username: "cocalc-claude",
  allowedHosts: CONNECTOR_HOSTS,
  // Claude's WebFetch: "no internet" exists to stop abuse by project code
  // (mining, spam, relays). The controller runs only Claude Code, with no shell
  // or file tools, and project code never sees this proxy credential.
  allowPublicHostSessions: true,
});

// Local names must never go through the proxy (e.g. COCALC_API_URL).
const NO_PROXY = "localhost,127.0.0.1,::1,host.containers.internal";

export interface ClaudeRestrictedEgress {
  env: Record<string, string>;
  close: () => void;
}

export function isAllowedClaudeEgressTarget(
  rawTarget: string,
  claudeAiConnectors = false,
): boolean {
  if (!proxy.isAllowedTarget(rawTarget)) return false;
  return (
    claudeAiConnectors ||
    new URL(`http://${rawTarget}`).hostname.toLowerCase().replace(/\.$/, "") !==
      CONNECTOR_HOST
  );
}

export function projectNeedsRestrictedClaudeEgress(projectId: string): boolean {
  return (
    projectNetworkPolicyFromRunQuota(getProject(projectId)?.run_quota) ===
    "disabled"
  );
}

/**
 * For a project without internet access, start a proxy session that lets
 * Claude Code reach Anthropic and return the environment that selects it.
 * `publicHosts` also opens public web hosts (never private networks) for
 * WebFetch: only for the isolated subscription controller, which has no shell
 * or file tools. Never for a harness inside the project, whose commands would
 * inherit the proxy and regain general internet access.
 * `host` is how the Claude container reaches the project host.
 */
export async function startClaudeRestrictedEgress({
  projectId,
  host,
  claudeAiConnectors = false,
  publicHosts = false,
}: {
  projectId: string;
  host?: string;
  claudeAiConnectors?: boolean;
  publicHosts?: boolean;
}): Promise<ClaudeRestrictedEgress | undefined> {
  if (!projectNeedsRestrictedClaudeEgress(projectId)) return;
  const session: RestrictedEgressProxySession = await proxy.startSession({
    host,
    allowedHosts: claudeAiConnectors
      ? CONNECTOR_HOSTS
      : ALLOWED_ANTHROPIC_HOSTS,
    publicHosts,
    deniedHosts: claudeAiConnectors ? new Set() : new Set([CONNECTOR_HOST]),
  });
  return {
    env: {
      HTTPS_PROXY: session.proxyUrl,
      https_proxy: session.proxyUrl,
      NO_PROXY,
      no_proxy: NO_PROXY,
    },
    close: session.close,
  };
}

function defaultRouteInterface(): string | undefined {
  try {
    for (const line of readFileSync("/proc/net/route", "utf8")
      .trim()
      .split("\n")
      .slice(1)) {
      const [iface, destination] = line.trim().split(/\s+/);
      if (destination === "00000000") return iface;
    }
  } catch {
    // Not Linux, or /proc unavailable.
  }
}

/**
 * The project host's own IPv4 address, for containers on their own
 * slirp4netns network (the Claude subscription controller). Disabled project
 * networking still permits connections to local addresses, while slirp4netns
 * keeps host loopback services out of reach.
 */
export function projectHostAddress(): string | undefined {
  const explicit =
    `${process.env.COCALC_CLAUDE_EGRESS_PROXY_HOST ?? ""}`.trim();
  if (explicit) return explicit;
  const interfaces = networkInterfaces();
  const ipv4 = (name?: string) =>
    (name ? interfaces[name] : undefined)?.find(
      (address) => address.family === "IPv4" && !address.internal,
    )?.address;
  return (
    ipv4(defaultRouteInterface()) ??
    Object.keys(interfaces)
      .map((name) => ipv4(name))
      .find((address) => address != null)
  );
}

export function shutdownClaudeRestrictedEgressForTesting(): Promise<void> {
  return proxy.shutdown();
}
