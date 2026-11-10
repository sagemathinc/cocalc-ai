/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The email an account gets when a fresh auth longer than 8 hours starts (see
util/auth/fresh-auth-duration). Such a verification lets anyone holding that
session, a browser or a CLI, do security actions for up to 72 hours, so the
owner should hear about it right away and know how to end it.

It goes out both when a session is verified for that long and when a CLI sign-in
is approved with such a verification (a new session, often on another
machine). Besides the email, an in-app notification records it, so a lost or
filtered email still leaves a trace in the account.

Sending is best effort: a missing email backend or address must not undo a
verification that already succeeded, so failures are only logged.
*/

import getLogger from "@cocalc/backend/logger";
import { createNotificationEventGraph } from "@cocalc/database/postgres/notifications-core";
import siteURL from "@cocalc/database/settings/site-url";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getEmailAddress from "@cocalc/server/accounts/get-email-address";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import sendEmail from "@cocalc/server/email/send-email";
import { FRESH_AUTH_EXTENDED_MS } from "@cocalc/util/auth/fresh-auth-duration";
import { SITE_NAME } from "@cocalc/util/theme";

const logger = getLogger("server:auth:fresh-auth-notice");

// The few seconds between computing fresh_auth_until and writing it.
const SLACK_MS = 60_000;

export function isLongFreshAuthUntil(
  fresh_auth_until: Date,
  now: number = Date.now(),
): boolean {
  return fresh_auth_until.valueOf() - now > FRESH_AUTH_EXTENDED_MS + SLACK_MS;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The client's user agent is chosen by whoever signs in: in the in-app notice
// it must stay plain text, never a link or an image.
function escapeMarkdown(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_{}\[\]()#+\-.!<>|~&:]/g, (c) => `\\${c}`);
}

function describeFactor(factor_level: string): string {
  switch (factor_level) {
    case "totp":
      return "an authenticator app code";
    case "passkey":
      return "a passkey";
    case "google_oidc":
      return "Google";
    default:
      return factor_level;
  }
}

export interface LongFreshAuthNotice {
  account_id: string;
  fresh_auth_until: Date;
  factor_level: string;
  ip_address?: string | null;
  user_agent?: string | null;
  // "cli_login": a CLI sign-in was approved with this verification.
  source?: "verification" | "cli_login";
}

function hoursUntil(fresh_auth_until: Date): number {
  return Math.round((fresh_auth_until.valueOf() - Date.now()) / (60 * 60_000));
}

function noticeDetails({
  fresh_auth_until,
  factor_level,
  ip_address,
  user_agent,
}: LongFreshAuthNotice): string[] {
  return [
    `Verified with: ${describeFactor(factor_level)}`,
    `Active until: ${fresh_auth_until.toUTCString()}`,
    ...(ip_address ? [`IP address: ${ip_address}`] : []),
    ...(user_agent ? [`Browser or client: ${user_agent.slice(0, 200)}`] : []),
  ];
}

function noticeLead(siteName: string, hours: number, source?: string): string {
  const account = siteName ? `your ${siteName} account` : "your account";
  return source === "cli_login"
    ? `A CLI sign-in to ${account} just received a verification that allows security actions for about ${hours} hours.`
    : `A verification that allows security actions on ${account} for about ${hours} hours just started.`;
}

// The email and the in-app notification, both best effort.
export async function notifyLongFreshAuth(
  opts: LongFreshAuthNotice,
): Promise<void> {
  await Promise.all([
    sendLongFreshAuthNotice(opts),
    recordLongFreshAuthNotification(opts),
  ]);
}

export async function recordLongFreshAuthNotification(
  opts: LongFreshAuthNotice,
): Promise<void> {
  const { account_id, fresh_auth_until, source } = opts;
  try {
    const bay = getConfiguredBayId();
    const hours = hoursUntil(fresh_auth_until);
    const details = noticeDetails(opts)
      .map((line) => `- ${escapeMarkdown(line)}`)
      .join("\n");
    const summary = {
      title:
        source === "cli_login"
          ? `CLI sign-in allowed security actions for ${hours} hours`
          : `Security actions allowed for ${hours} hours`,
      severity: "warning",
      origin_label: "Account security",
      notice_type: "long_fresh_auth",
      body_markdown: [
        noticeLead("", hours, source),
        details,
        "If this was not you, end it now, change your password and end your other sign-in sessions.",
      ].join("\n\n"),
      action_label: "Review or end it",
      action_link: "/settings/profile#security",
    };
    // Only called on the account's home bay (where its sessions are written).
    await createNotificationEventGraph({
      kind: "account_notice",
      source_bay_id: bay,
      origin_kind: "system",
      payload_json: summary,
      targets: [
        {
          target_account_id: account_id,
          target_home_bay_id: bay,
          summary_json: summary,
        },
      ],
    });
  } catch (err) {
    logger.warn("could not record the long fresh auth notification", {
      account_id,
      err: `${err}`,
    });
  }
}

export async function sendLongFreshAuthNotice(
  opts: LongFreshAuthNotice,
): Promise<void> {
  const { account_id, fresh_auth_until, source } = opts;
  try {
    const email_address = `${(await getEmailAddress(account_id)) ?? ""}`.trim();
    if (!email_address) {
      logger.debug("long fresh auth: no email address", { account_id });
      return;
    }
    const settings = await getServerSettings();
    const siteName = `${settings.site_name ?? ""}`.trim() || SITE_NAME;
    const securityUrl = `${await siteURL()}/settings/profile#security`;
    const hours = hoursUntil(fresh_auth_until);
    const details = noticeDetails(opts);
    const lead = noticeLead(siteName, hours, source);
    const subject = `${siteName}: security actions allowed for ${hours} hours`;
    const text = `Hello,

${lead}

${details.join("\n")}

If this was you, there is nothing to do. To end it early, or if this was not you, go to
${securityUrl}
and click "End now". If it was not you, also change your password and end your other sign-in sessions.
`;
    const html = `<div>
<p>Hello,</p>
<p>${escapeHtml(lead)}</p>
<ul>${details.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
<p>If this was you, there is nothing to do. To end it early, or if this was not you, open
<a href="${escapeHtml(securityUrl)}">${escapeHtml(securityUrl)}</a> and click <b>End now</b>.
If it was not you, also change your password and end your other sign-in sessions.</p>
</div>`;
    await sendEmail(
      { to: email_address, subject, text, html, categories: ["security"] },
      account_id,
      "critical",
    );
  } catch (err) {
    logger.warn("could not send the long fresh auth notice", {
      account_id,
      err: `${err}`,
    });
  }
}
