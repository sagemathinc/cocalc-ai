/*
 *  This file is part of CoCalc: Copyright © 2021 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Send email using whichever email_backend is configured in the database,
or throw an exception if none is properly configured.
*/

import type { Message } from "./message";
import sendViaSMTP from "./smtp";
import sendViaSendgrid from "./sendgrid";
import sendEmailThrottle from "./throttle";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  normalizeEmailBackend,
  notificationEmailBackendSettingName,
  resolveEmailBackendForLane,
  type EmailLane,
} from "@cocalc/util/notification-email";

export const testEmails: Message[] = [];
export function resetTestEmails() {
  testEmails.length = 0;
}

export default async function sendEmail(
  message: Message,
  account_id?: string, // account that we are sending this email *on behalf of*, if any (used for throttling).
  lane: EmailLane = "transactional",
): Promise<void> {
  if (process.env.COCALC_TEST_MODE) {
    // In testing mode, we just push emails into a list. The test framework can then check to see
    // what happened.
    testEmails.push(message);
    return;
  }

  await sendEmailThrottle(account_id);

  const settings = await getServerSettings();
  const backend = resolveEmailBackendForLane(settings, lane);
  const defaultBackend = normalizeEmailBackend(settings.email_backend);
  const laneBackend = `${settings[notificationEmailBackendSettingName(lane)] ?? "default"}`;
  switch (backend) {
    case "":
    case "none":
      throw Error(`no email backend configured`);
    case "smtp":
      try {
        return await sendViaSMTP(message);
      } catch (err) {
        if (laneBackend !== "default" && defaultBackend == "sendgrid") {
          return await sendViaSendgrid(message);
        }
        throw err;
      }
    case "sendgrid":
      return await sendViaSendgrid(message);
    default:
      throw Error(`no valid email backend configured: ${backend}`);
  }
}

export async function isEmailConfigured(lane: EmailLane = "transactional") {
  const settings = await getServerSettings();
  const backend = resolveEmailBackendForLane(settings, lane);
  if (!backend || backend == "none") {
    return false;
  } else {
    return true;
  }
}
