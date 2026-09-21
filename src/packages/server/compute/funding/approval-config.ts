/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { normalizeCloudflareHostname } from "@cocalc/server/cloud/derived-domains";

export interface FundingApprovalListenerConfig {
  origin: string;
  listen_host: "127.0.0.2";
  listen_port: number;
  // HTTPS terminates at a dedicated loopback proxy; never trust arbitrary XFF.
  trusted_proxy_ip?: "127.0.0.1" | "127.0.0.2";
  application_origins: string[];
  webauthn_rp_id?: string;
}

export type FundingApprovalConfiguration =
  | {
      state: "configured";
      source: "environment" | "managed-cloudflare";
      config: FundingApprovalListenerConfig;
    }
  | {
      state: "disabled" | "configuration_required";
      source: "environment" | "managed-cloudflare";
      reason: string;
    };

const DEFAULT_FUNDING_APPROVAL_PORT = 19212;
export const FUNDING_APPROVAL_HEALTH_PATH =
  "/.well-known/cocalc-financial-approval-health";
export const FUNDING_APPROVAL_HEALTH_SERVICE = "cocalc-financial-approval";

function clean(value: unknown): string | undefined {
  const text = `${value ?? ""}`.trim();
  return text || undefined;
}

function enabled(value: unknown): boolean {
  if (value === true) return true;
  const text = clean(value)?.toLowerCase();
  return !!text && !["0", "false", "no", "off"].includes(text);
}

export function deriveFundingApprovalHostname(
  siteHostname: string,
): string | undefined {
  const hostname = normalizeCloudflareHostname(siteHostname);
  if (!hostname) return;
  const labels = hostname.split(".");
  if (labels.length <= 2) return `authorize.${hostname}`;
  return `${labels[0]}-authorize.${labels.slice(1).join(".")}`;
}

export function fundingApprovalRelatedOrigin(
  config: FundingApprovalListenerConfig,
): string | undefined {
  const approval = validateFundingOrigin(config.origin);
  if (approval.protocol !== "https:") return;
  const rpId = `${config.webauthn_rp_id ?? ""}`.trim().toLowerCase();
  if (!rpId || approval.hostname.endsWith(`.${rpId}`)) return;
  return approval.origin;
}

export function validateFundingOrigin(origin: string): URL {
  const url = new URL(origin);
  const dev =
    url.protocol === "http:" && url.hostname === "127.0.0.2" && !!url.port;
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (!dev && url.protocol !== "https:") ||
    (dev && process.env.NODE_ENV === "production")
  ) {
    throw new Error(
      "Financial approval requires an isolated HTTPS origin (or dev http://127.0.0.2:<port>)",
    );
  }
  return url;
}

export function validateFundingListener(config: FundingApprovalListenerConfig) {
  const url = validateFundingOrigin(config.origin);
  if (
    config.listen_host !== "127.0.0.2" ||
    !Number.isInteger(config.listen_port) ||
    config.listen_port < 1024 ||
    config.listen_port > 65535
  ) {
    throw new Error(
      "Financial approval requires a dedicated 127.0.0.2 listener on an unprivileged port",
    );
  }
  if (
    !config.application_origins.length ||
    config.application_origins.some(
      (origin) => new URL(origin).hostname === url.hostname,
    )
  ) {
    throw new Error(
      "Financial approval must not share a host with an application origin",
    );
  }
  if (url.protocol === "https:") {
    if (!["127.0.0.1", "127.0.0.2"].includes(config.trusted_proxy_ip ?? "")) {
      throw new Error(
        "HTTPS financial approval requires a pinned loopback TLS proxy",
      );
    }
    const rpId = `${config.webauthn_rp_id ?? ""}`.trim().toLowerCase();
    if (
      !rpId ||
      url.hostname === rpId ||
      !config.application_origins.some(
        (origin) => new URL(origin).hostname === rpId,
      )
    ) {
      throw new Error(
        "HTTPS financial approval requires a WebAuthn RP ID matching an application origin and distinct from the approval host",
      );
    }
  } else if (
    config.trusted_proxy_ip ||
    config.listen_port !== Number(url.port)
  ) {
    throw new Error(
      "Dev financial approval must use the direct isolated listener",
    );
  }
  return url;
}

export function fundingApprovalConfigFromEnv():
  | FundingApprovalListenerConfig
  | undefined {
  if (process.env.COCALC_FUNDING_APPROVAL_ENABLED !== "1") return;
  const config: FundingApprovalListenerConfig = {
    origin: process.env.COCALC_FUNDING_APPROVAL_ORIGIN ?? "",
    listen_host: "127.0.0.2",
    listen_port: Number(process.env.COCALC_FUNDING_APPROVAL_PORT),
    trusted_proxy_ip: process.env
      .COCALC_FUNDING_APPROVAL_PROXY_IP as FundingApprovalListenerConfig["trusted_proxy_ip"],
    application_origins: (
      process.env.COCALC_FUNDING_APPROVAL_APPLICATION_ORIGINS ?? ""
    )
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    webauthn_rp_id: process.env.COCALC_FUNDING_APPROVAL_WEBAUTHN_RP_ID,
  };
  validateFundingListener(config);
  return config;
}

export async function resolveFundingApprovalConfiguration(): Promise<FundingApprovalConfiguration> {
  const explicit = clean(process.env.COCALC_FUNDING_APPROVAL_ENABLED);
  if (explicit != null) {
    if (explicit !== "1") {
      return {
        state: "disabled",
        source: "environment",
        reason: "Secure financial authorization is explicitly disabled.",
      };
    }
    const config = fundingApprovalConfigFromEnv();
    if (!config) throw new Error("Financial approval configuration is missing");
    return { state: "configured", source: "environment", config };
  }

  const settings = await getServerSettings();
  const stripeConfigured =
    !!clean(settings.stripe_publishable_key) &&
    !!clean(settings.stripe_secret_key);
  if (!stripeConfigured) {
    return {
      state: "disabled",
      source: "managed-cloudflare",
      reason: "Purchasing is not configured on this site.",
    };
  }

  const cloudflareMode = clean(settings.cloudflare_mode)?.toLowerCase();
  const managedCloudflare =
    cloudflareMode === "self" ||
    enabled(settings.project_hosts_cloudflare_tunnel_enabled);
  const siteHostname = normalizeCloudflareHostname(settings.dns);
  const cloudflareCredentials =
    !!clean(settings.project_hosts_cloudflare_tunnel_account_id) &&
    !!clean(settings.project_hosts_cloudflare_tunnel_api_token);
  if (!managedCloudflare || !siteHostname || !cloudflareCredentials) {
    return {
      state: "configuration_required",
      source: "managed-cloudflare",
      reason:
        "Purchasing requires managed Cloudflare DNS and tunnel credentials for secure financial authorization.",
    };
  }

  const originOverride = clean(process.env.COCALC_FUNDING_APPROVAL_ORIGIN);
  const approvalHostname = deriveFundingApprovalHostname(siteHostname);
  if (!approvalHostname) {
    return {
      state: "configuration_required",
      source: "managed-cloudflare",
      reason: "The site domain is invalid for financial authorization.",
    };
  }
  const config: FundingApprovalListenerConfig = {
    origin: originOverride ?? `https://${approvalHostname}`,
    listen_host: "127.0.0.2",
    listen_port: Number(
      clean(process.env.COCALC_FUNDING_APPROVAL_PORT) ??
        DEFAULT_FUNDING_APPROVAL_PORT,
    ),
    trusted_proxy_ip: (clean(process.env.COCALC_FUNDING_APPROVAL_PROXY_IP) ??
      "127.0.0.1") as FundingApprovalListenerConfig["trusted_proxy_ip"],
    application_origins: (
      clean(process.env.COCALC_FUNDING_APPROVAL_APPLICATION_ORIGINS) ??
      `https://${siteHostname}`
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    webauthn_rp_id:
      clean(process.env.COCALC_FUNDING_APPROVAL_WEBAUTHN_RP_ID) ?? siteHostname,
  };
  validateFundingListener(config);
  return { state: "configured", source: "managed-cloudflare", config };
}
