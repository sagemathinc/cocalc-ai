/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export interface FundingApprovalListenerConfig {
  origin: string;
  listen_host: "127.0.0.2";
  listen_port: number;
  // HTTPS terminates at a dedicated loopback proxy; never trust arbitrary XFF.
  trusted_proxy_ip?: "127.0.0.1" | "127.0.0.2";
  application_origins: string[];
  webauthn_rp_id?: string;
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
      !url.hostname.endsWith(`.${rpId}`) ||
      !config.application_origins.some(
        (origin) => new URL(origin).hostname === rpId,
      )
    ) {
      throw new Error(
        "HTTPS financial approval requires a WebAuthn RP ID matching an application origin and parent of the approval host",
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
