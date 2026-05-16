/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import sendEmail from "@cocalc/server/email/send-email";
import sendViaSMTP from "@cocalc/server/email/smtp";
import { getVerifyEmail } from "@cocalc/server/email/verify";
import sendWelcomeEmail from "@cocalc/server/email/welcome-email";
import type { Message } from "@cocalc/server/email/message";
import { isValidUUID } from "@cocalc/util/misc";
import { SITE_NAME } from "@cocalc/util/theme";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("server:send-email-verification");

async function getEmailAddress(account_id: string): Promise<string> {
  const { rows } = await getPool().query(
    "SELECT email_address FROM accounts WHERE account_id=$1",
    [account_id],
  );
  const email_address = `${rows[0]?.email_address ?? ""}`.trim().toLowerCase();
  if (!email_address) {
    throw Error("account has no email address");
  }
  return email_address;
}

export default async function sendEmailVerification(
  account_id: string,
  only_verify = true,
): Promise<string | undefined> {
  if (!isValidUUID(account_id)) {
    throw Error("account_id is not valid");
  }
  try {
    const email_address = await getEmailAddress(account_id);
    if (!only_verify) {
      await sendWelcomeEmail(email_address, account_id);
    } else {
      const [{ html, text }, settings] = await Promise.all([
        getVerifyEmail(email_address),
        getServerSettings(),
      ]);
      const siteName = `${settings.site_name ?? ""}`.trim() || SITE_NAME;
      const message: Message = {
        to: email_address,
        subject: `Verify your email address on ${siteName}`,
        text,
        html,
        categories: ["verify"],
        asm_group: 147985,
      };
      if (settings.password_reset_override === "smtp") {
        try {
          await sendViaSMTP(message, "password_reset");
        } catch (err) {
          logger.debug(
            `verification email via secondary smtp failed for account_id=${account_id}; falling back to critical lane -- ${err}`,
          );
          await sendEmail(message, account_id, "critical");
        }
      } else {
        await sendEmail(message, account_id, "critical");
      }
    }
    logger.debug(
      `successfully sent verification email for account_id=${account_id}`,
    );
  } catch (err) {
    logger.debug(
      `failed to send verification email for account_id=${account_id} -- ${err}`,
    );
    return err instanceof Error ? err.message : `${err}`;
  }
  return "";
}
