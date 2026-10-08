/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Kept apart from cli-connectors.ts: the public site settings (in the
// browser's startup bundle) need only this.

/**
 * The connectors this site has set up, from its site settings. Nothing about
 * a connector (UI, PATH wrappers, per-turn requests) is active unless it is
 * listed here. Public: names only, never secrets.
 */
export function enabledCliConnectors(
  settings: Record<string, unknown>,
): ("github" | "cloudflare")[] {
  const set = (key: string) => `${settings[key] ?? ""}`.trim().length > 0;
  const enabled: ("github" | "cloudflare")[] = [];
  if (
    set("github_connector_client_id") &&
    set("github_connector_client_secret")
  ) {
    enabled.push("github");
  }
  if (
    set("cloudflare_connector_client_id") &&
    set("cloudflare_connector_client_secret")
  ) {
    enabled.push("cloudflare");
  }
  return enabled;
}
