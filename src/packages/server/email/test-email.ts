/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  normalizeEmailLane,
  notificationEmailBackendSettingName,
  resolveEmailBackendForLane,
  type EmailBackend,
  type EmailLane,
  type EmailLaneBackend,
} from "@cocalc/util/notification-email";
import { SITE_NAME } from "@cocalc/util/theme";
import type { Message } from "./message";
import sendViaSMTP from "./smtp";
import sendViaSendgrid from "./sendgrid";

export interface TestEmailRouteStep {
  backend: Exclude<EmailBackend, "" | "none">;
  source: "lane" | "primary-smtp" | "secondary-smtp" | "default-fallback";
  status: "accepted" | "failed" | "skipped";
  error?: string;
}

export type TestEmailMode = "critical" | "verification";

export interface TestEmailResult {
  mode: TestEmailMode;
  to: string;
  lane: EmailLane;
  success: boolean;
  resolved_backend: EmailBackend;
  default_backend: EmailBackend;
  lane_backend: EmailLaneBackend;
  configured: {
    sendgrid_key: boolean;
    primary_smtp: {
      server: boolean;
      from: boolean;
      login: boolean;
      password: boolean;
    };
    secondary_smtp: {
      enabled: boolean;
      server: boolean;
      from: boolean;
      login: boolean;
      password: boolean;
    };
  };
  route: TestEmailRouteStep[];
}

function getConfigured(
  settings: Record<string, any>,
): TestEmailResult["configured"] {
  return {
    sendgrid_key: !!settings.sendgrid_key,
    primary_smtp: {
      server: !!settings.email_smtp_server,
      from: !!settings.email_smtp_from,
      login: !!settings.email_smtp_login,
      password: !!settings.email_smtp_password,
    },
    secondary_smtp: {
      enabled: settings.password_reset_override === "smtp",
      server: !!settings.password_reset_smtp_server,
      from: !!settings.password_reset_smtp_from,
      login: !!settings.password_reset_smtp_login,
      password: !!settings.password_reset_smtp_password,
    },
  };
}

function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : `${err}`;
  return message
    .replace(
      /(password|pass|token|apikey|api[_ -]?key|secret)=([^&\s]+)/gi,
      "$1=[redacted]",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]");
}

async function getAccountEmailAddress(account_id: string): Promise<string> {
  const { rows } = await getPool().query(
    "SELECT email_address FROM accounts WHERE account_id=$1",
    [account_id],
  );
  const email = `${rows[0]?.email_address ?? ""}`.trim().toLowerCase();
  if (!email) {
    throw Error("your account has no configured email address");
  }
  return email;
}

function backendLabel(backend: EmailBackend): backend is "sendgrid" | "smtp" {
  return backend === "sendgrid" || backend === "smtp";
}

function normalizeTestEmailMode(mode: unknown): TestEmailMode {
  switch (mode) {
    case "critical":
    case "verification":
      return mode;
    default:
      throw Error(`invalid test email mode '${mode ?? ""}'`);
  }
}

async function sendViaBackend(
  message: Message,
  backend: "sendgrid" | "smtp",
): Promise<void> {
  switch (backend) {
    case "smtp":
      await sendViaSMTP(message, "email");
      return;
    case "sendgrid":
      await sendViaSendgrid(message);
      return;
  }
}

async function sendViaCriticalRoute({
  message,
  route,
  resolved_backend,
  default_backend,
}: {
  message: Message;
  route: TestEmailRouteStep[];
  resolved_backend: EmailBackend;
  default_backend: EmailBackend;
}): Promise<boolean> {
  const fallback_backend =
    resolved_backend === "smtp" && default_backend !== "smtp"
      ? default_backend
      : "";
  const backends = [resolved_backend, fallback_backend].filter(
    (backend): backend is "sendgrid" | "smtp" => backendLabel(backend),
  );

  for (const backend of backends) {
    const source =
      backend === resolved_backend
        ? backend === "smtp"
          ? "primary-smtp"
          : "lane"
        : "default-fallback";
    try {
      await sendViaBackend({ ...message }, backend);
      route.push({ backend, source, status: "accepted" });
      return true;
    } catch (err) {
      route.push({
        backend,
        source,
        status: "failed",
        error: sanitizeError(err),
      });
    }
  }
  return false;
}

export async function sendTestEmail({
  account_id,
  lane = "critical",
  mode = "critical",
}: {
  account_id: string;
  lane?: EmailLane;
  mode?: TestEmailMode;
}): Promise<TestEmailResult> {
  const normalizedLane = normalizeEmailLane(lane);
  const normalizedMode = normalizeTestEmailMode(mode);
  const [settings, to] = await Promise.all([
    getServerSettings(),
    getAccountEmailAddress(account_id),
  ]);
  const siteName = `${settings.site_name ?? ""}`.trim() || SITE_NAME;
  const default_backend = `${settings.email_backend ?? ""}` as EmailBackend;
  const lane_backend = `${
    settings[notificationEmailBackendSettingName(normalizedLane)] ?? "default"
  }` as EmailLaneBackend;
  const configured = getConfigured(settings);
  const resolved_backend = resolveEmailBackendForLane(settings, normalizedLane);
  const route: TestEmailRouteStep[] = [];

  const message: Message = {
    to,
    subject:
      normalizedMode === "verification"
        ? `CoCalc verification test email from ${siteName}`
        : `CoCalc test email from ${siteName}`,
    text:
      normalizedMode === "verification"
        ? `This is a verification-route test email from ${siteName}.\n\nIf you received this, the email verification route is working.`
        : `This is a test email from ${siteName}.\n\nIf you received this, the ${normalizedLane} email route is working.`,
    html:
      normalizedMode === "verification"
        ? `<p>This is a verification-route test email from ${siteName}.</p><p>If you received this, the email verification route is working.</p>`
        : `<p>This is a test email from ${siteName}.</p><p>If you received this, the <b>${normalizedLane}</b> email route is working.</p>`,
    categories:
      normalizedMode === "verification"
        ? ["verify", "admin-test"]
        : ["admin-test"],
  };

  let success = false;
  if (
    normalizedMode === "verification" &&
    settings.password_reset_override === "smtp"
  ) {
    try {
      await sendViaSMTP({ ...message }, "password_reset");
      route.push({
        backend: "smtp",
        source: "secondary-smtp",
        status: "accepted",
      });
      success = true;
    } catch (err) {
      route.push({
        backend: "smtp",
        source: "secondary-smtp",
        status: "failed",
        error: sanitizeError(err),
      });
    }
  }

  if (!success) {
    success = await sendViaCriticalRoute({
      message,
      route,
      resolved_backend,
      default_backend,
    });
  }

  return {
    mode: normalizedMode,
    to,
    lane: normalizedLane,
    success,
    resolved_backend,
    default_backend,
    lane_backend,
    configured,
    route,
  };
}
