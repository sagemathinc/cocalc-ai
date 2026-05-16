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
  source: "lane" | "default-fallback";
  status: "accepted" | "failed" | "skipped";
  error?: string;
}

export interface TestEmailResult {
  to: string;
  lane: EmailLane;
  success: boolean;
  resolved_backend: EmailBackend;
  default_backend: EmailBackend;
  lane_backend: EmailLaneBackend;
  route: TestEmailRouteStep[];
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

export async function sendTestEmail({
  account_id,
  lane = "critical",
}: {
  account_id: string;
  lane?: EmailLane;
}): Promise<TestEmailResult> {
  const normalizedLane = normalizeEmailLane(lane);
  const [settings, to] = await Promise.all([
    getServerSettings(),
    getAccountEmailAddress(account_id),
  ]);
  const siteName = `${settings.site_name ?? ""}`.trim() || SITE_NAME;
  const default_backend = `${settings.email_backend ?? ""}` as EmailBackend;
  const lane_backend = `${
    settings[notificationEmailBackendSettingName(normalizedLane)] ?? "default"
  }` as EmailLaneBackend;
  const resolved_backend = resolveEmailBackendForLane(settings, normalizedLane);
  const fallback_backend =
    resolved_backend === "smtp" && default_backend !== "smtp"
      ? default_backend
      : "";
  const route: TestEmailRouteStep[] = [];
  const backends = [resolved_backend, fallback_backend].filter(
    (backend): backend is "sendgrid" | "smtp" => backendLabel(backend),
  );

  if (backends.length === 0) {
    return {
      to,
      lane: normalizedLane,
      success: false,
      resolved_backend,
      default_backend,
      lane_backend,
      route,
    };
  }

  const message: Message = {
    to,
    subject: `CoCalc test email from ${siteName}`,
    text: `This is a test email from ${siteName}.\n\nIf you received this, the ${normalizedLane} email route is working.`,
    html: `<p>This is a test email from ${siteName}.</p><p>If you received this, the <b>${normalizedLane}</b> email route is working.</p>`,
    categories: ["admin-test"],
  };

  for (const backend of backends) {
    const source = backend === resolved_backend ? "lane" : "default-fallback";
    try {
      await sendViaBackend({ ...message }, backend);
      route.push({ backend, source, status: "accepted" });
      return {
        to,
        lane: normalizedLane,
        success: true,
        resolved_backend,
        default_backend,
        lane_backend,
        route,
      };
    } catch (err) {
      route.push({
        backend,
        source,
        status: "failed",
        error: sanitizeError(err),
      });
    }
  }

  return {
    to,
    lane: normalizedLane,
    success: false,
    resolved_backend,
    default_backend,
    lane_backend,
    route,
  };
}
