/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// CLI connectors: services an agent uses through their own command-line tool
// (gh, cf) with a short-lived token CoCalc hands to each permitted turn. See
// src/.agents/cli-connectors-github-cloudflare-plan-2026-10-05.md.

export const CLI_CONNECTORS = ["github", "cloudflare"] as const;
export type CliConnector = (typeof CLI_CONNECTORS)[number];

export interface CliConnectorInfo {
  label: string;
  /** The command agents run. */
  command: string;
  /** Environment variable the command reads its token from. */
  envVar: string;
  /** External credential provider and kind holding the account connection. */
  provider: string;
  kind: string;
}

export const CLI_CONNECTOR_INFO: Record<CliConnector, CliConnectorInfo> = {
  github: {
    label: "GitHub",
    command: "gh",
    envVar: "GH_TOKEN",
    provider: "github",
    kind: "github-cli-connection",
  },
  cloudflare: {
    label: "Cloudflare",
    command: "cf",
    envVar: "CLOUDFLARE_API_TOKEN",
    provider: "cloudflare",
    kind: "cloudflare-cli-connection",
  },
};

export function isCliConnector(value: unknown): value is CliConnector {
  return (
    typeof value === "string" &&
    (CLI_CONNECTORS as readonly string[]).includes(value)
  );
}

/**
 * What the user lets agents do on Cloudflare. Each preset maps to cf OAuth
 * scopes; cf's default (about 481 scopes, the whole account) is never used.
 */
export const CLOUDFLARE_SCOPE_PRESETS = {
  workers: {
    label: "Workers & sites",
    scopes: [
      "workers:write",
      "workers_scripts:write",
      "workers_routes:write",
      "zone.read",
      "dns_records:edit",
    ],
  },
  r2: {
    label: "R2 storage",
    scopes: [
      "workers-r2.read",
      "workers-r2.write",
      "workers-r2-bucket-item.read",
      "workers-r2-bucket-item.write",
    ],
  },
  dns: {
    label: "DNS",
    scopes: ["zone.read", "dns_records:read", "dns_records:edit"],
  },
} as const;
export type CloudflareScopePreset = keyof typeof CLOUDFLARE_SCOPE_PRESETS;

/** Scopes always requested so the connection can show who and where it is. */
export const CLOUDFLARE_BASE_SCOPES = ["account:read", "user:read"] as const;

export function cloudflareScopes(presets: readonly string[]): string[] {
  const scopes = new Set<string>(CLOUDFLARE_BASE_SCOPES);
  for (const preset of presets) {
    const known =
      CLOUDFLARE_SCOPE_PRESETS[preset as CloudflareScopePreset]?.scopes;
    if (!known) throw Error(`unknown Cloudflare preset: ${preset}`);
    for (const scope of known) scopes.add(scope);
  }
  return [...scopes];
}

/** A token handed to one agent turn; never a refresh token. */
export interface CliConnectorTurnToken {
  connector: CliConnector;
  token: string;
  /** Milliseconds since epoch. */
  expires_at: number;
  /** Shown to the agent, e.g. "@octocat" or "Example Inc (Workers & sites)". */
  description: string;
}
