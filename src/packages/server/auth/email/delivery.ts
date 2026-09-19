/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import siteURL from "@cocalc/database/settings/site-url";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import sendEmail from "@cocalc/server/email/send-email";
import appendFooter from "@cocalc/server/email/footer";
import { appendUrlPath } from "@cocalc/util/url-path";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function sendEmailAuthChallengeMessage({
  challenge_id,
  code,
  email_address,
  link_token,
  purpose,
  code_only = false,
}: {
  challenge_id: string;
  code: string;
  email_address: string;
  link_token: string;
  purpose: "sign_in_or_sign_up" | "email_fresh_auth";
  code_only?: boolean;
}): Promise<void> {
  const [{ site_name }, site_url] = await Promise.all([
    getServerSettings(),
    siteURL(),
  ]);
  const siteName = `${site_name ?? "CoCalc"}`;
  const continueUrl = `${appendUrlPath(
    site_url,
    `auth/email/continue/${challenge_id}`,
  )}#token=${encodeURIComponent(link_token)}`;
  const safeSiteName = escapeHtml(siteName);
  const safeContinueUrl = escapeHtml(continueUrl);
  const isFreshAuth = purpose === "email_fresh_auth";
  const action = isFreshAuth ? "approve this security action" : "continue";
  const linkAction = isFreshAuth
    ? "Approve this action"
    : `Continue to ${safeSiteName}`;
  const linkHtml = code_only
    ? ""
    : `<p>Or use this approval link:</p><p><a href="${safeContinueUrl}">${linkAction}</a></p>`;
  const linkText = code_only
    ? ""
    : `\nOr open this approval link:\n\n${continueUrl}\n`;
  const html = `
<p>Use this code to ${action} in ${safeSiteName}:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:24px 0">${code}</p>
${linkHtml}
<p style="color:#666">This ${code_only ? "code expires" : "code and link expire"} in 15 minutes. If you did not request this, you can ignore this message.</p>
`;
  const text = `Use this code to ${action} in ${siteName}:

${code}
${linkText}
This ${code_only ? "code expires" : "code and link expire"} in 15 minutes. If you did not request this, you can ignore this message.
`;
  await sendEmail(
    await appendFooter({
      to: email_address,
      subject: `${code} is your ${siteName} ${isFreshAuth ? "approval" : "sign-in"} code`,
      html,
      text,
      categories: ["email-auth"],
    }),
    undefined,
    "critical",
  );
}
