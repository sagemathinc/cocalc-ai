/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The email an account gets when a fresh auth longer than 8 hours starts (see
util/auth/fresh-auth-duration). Such a verification lets anyone holding that
session, a browser or a CLI, do security actions for up to 72 hours, so the
owner should hear about it right away and know how to end it.

Sending is best effort: a missing email backend or address must not undo a
verification that already succeeded, so failures are only logged.
*/

import getLogger from "@cocalc/backend/logger";
import siteURL from "@cocalc/database/settings/site-url";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getEmailAddress from "@cocalc/server/accounts/get-email-address";
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

export async function sendLongFreshAuthNotice({
  account_id,
  fresh_auth_until,
  factor_level,
  ip_address,
  user_agent,
}: {
  account_id: string;
  fresh_auth_until: Date;
  factor_level: string;
  ip_address?: string | null;
  user_agent?: string | null;
}): Promise<void> {
  try {
    const email_address = `${(await getEmailAddress(account_id)) ?? ""}`.trim();
    if (!email_address) {
      logger.debug("long fresh auth: no email address", { account_id });
      return;
    }
    const settings = await getServerSettings();
    const siteName = `${settings.site_name ?? ""}`.trim() || SITE_NAME;
    const securityUrl = `${await siteURL()}/settings/profile#security`;
    const hours = Math.round(
      (fresh_auth_until.valueOf() - Date.now()) / (60 * 60_000),
    );
    const until = fresh_auth_until.toUTCString();
    const details = [
      `Verified with: ${describeFactor(factor_level)}`,
      `Active until: ${until}`,
      ...(ip_address ? [`IP address: ${ip_address}`] : []),
      ...(user_agent ? [`Browser or client: ${user_agent.slice(0, 200)}`] : []),
    ];
    const subject = `${siteName}: security actions allowed for ${hours} hours`;
    const text = `Hello,

A verification that allows security actions on your ${siteName} account for about ${hours} hours just started.

${details.join("\n")}

If this was you, there is nothing to do. To end it early, or if this was not you, go to
${securityUrl}
and click "End now". If it was not you, also change your password and end your other sign-in sessions.
`;
    const html = `<div>
<p>Hello,</p>
<p>A verification that allows security actions on your ${escapeHtml(siteName)} account for about <b>${hours} hours</b> just started.</p>
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
