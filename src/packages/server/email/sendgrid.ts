/* We use the official V3 Sendgrid API:

https://www.npmjs.com/package/@sendgrid/mail

The cocalc ASM group numbers are at

https://app.sendgrid.com/suppressions/advanced_suppression_manager
*/

import sgMail from "@sendgrid/mail";

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { SENDGRID_TEMPLATE_ID } from "@cocalc/util/theme";
import appendFooter from "./footer";
import getHelpEmail from "./help";
import type { Message } from "./message";

// Init throws error if we can't initialize Sendgrid right now.
// It also updates the key if it changes in at most one minute (?).
let initialized = 0;
export async function getSendgrid(): Promise<any> {
  const now = Date.now();
  if (now - initialized < 1000 * 30) {
    // initialized recently
    return sgMail;
  }
  const { sendgrid_key: apiKey } = await getServerSettings();
  if (!apiKey) {
    if (initialized) {
      // no key now, but there was a key before -- so clear it and error
      sgMail.setApiKey("");
    }
    throw Error("no sendgrid key");
  }
  sgMail.setApiKey(apiKey);
  initialized = Date.now();
  return sgMail;
}

export default async function sendEmail(message: Message): Promise<void> {
  const sg = await getSendgrid();
  const msg: any = await appendFooter(message);
  if (!msg.from) {
    msg.from = await getHelpEmail(); // fallback
  }
  if (msg.asm_group) {
    msg.asm = { group_id: msg.asm_group };
    delete msg.asm_group;
  }
  // plain template with a header (cocalc logo), a h1 title, and a footer
  msg.template_id = SENDGRID_TEMPLATE_ID;

  // https://docs.sendgrid.com/api-reference/mail-send/mail-send
  await sg.send(msg);
}
