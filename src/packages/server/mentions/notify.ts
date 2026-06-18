/*
 *  This file is part of CoCalc: Copyright © 2021 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings";
import siteURL from "@cocalc/database/settings/site-url";
import getEmailAddress from "@cocalc/server/accounts/get-email-address";
import getName from "@cocalc/server/accounts/get-name";
import sendEmail from "@cocalc/server/email/send-email";
import {
  escapeNotificationEmailHtml,
  normalizeNotificationEmailText,
} from "@cocalc/server/notifications/email-format";
import getProjectTitle from "@cocalc/server/projects/get-title";
import { path_split, trunc, trunc_middle } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import type { Action, Key } from "./types";

const HOWTO_REPLY =
  "Reply in CoCalc using the link above; replies to this email are not delivered.";
const MAX_SUBJECT_LENGTH = 120;

export default async function sendNotificationIfPossible(
  key: Key,
  source: string,
  description: string,
): Promise<Action> {
  const to = await getEmailAddress(key.target);
  if (!to) {
    // Email is the only notification method at present.
    // Nothing more to do -- target user has no known email address.
    // They will see notification when they sign in.
    return "nothing";
  }

  const sourceName = trunc((await getName(source)) ?? "Unknown User", 60);
  const projectTitle = await getProjectTitle(key.project_id);
  const emailDescription = normalizeNotificationEmailText(description);

  const context =
    emailDescription.length > 0
      ? `<br/><blockquote>${escapeNotificationEmailHtml(
          emailDescription,
        )}</blockquote>`
      : "";
  const subject = mentionEmailSubject({
    sourceName,
    projectTitle,
    path: key.path,
  });
  const url = `${await siteURL()}/projects/${key.project_id}/files/${key.path}${
    key.fragment_id
      ? (key.fragment_id.startsWith("#") ? "" : "#") + key.fragment_id
      : ""
  }`;
  const safeUrl = escapeNotificationEmailHtml(url);
  const safePath = escapeNotificationEmailHtml(key.path);
  const safeProjectTitle = escapeNotificationEmailHtml(projectTitle);
  const safeSourceName = escapeNotificationEmailHtml(sourceName);
  const html = `
${safeSourceName} mentioned you in
<a href="${safeUrl}">${safePath}</a> in ${safeProjectTitle}.
${context}
<br/>
<br/>
<div style="color: ${COLORS.GRAY_M};">${HOWTO_REPLY}</div>
`;

  const text = `
${sourceName} mentioned you in ${key.path} in ${projectTitle}.

    ${url}

${emailDescription ? "> " : ""}${emailDescription}

---

${HOWTO_REPLY}
`;

  const { help_email } = await getServerSettings();
  const from = `${sourceName} <${help_email}>`;

  await sendEmail(
    {
      from,
      to,
      subject,
      text,
      html,
      categories: ["notification"],
      asm_group: 148185, // see https://app.sendgrid.com/suppressions/advanced_suppression_manager
    },
    source,
  );
  return "email";
}

export function mentionEmailSubject({
  sourceName,
  projectTitle,
  path,
}: {
  sourceName: string;
  projectTitle: string;
  path: string;
}): string {
  const filename = mentionPathLabel(path);
  const subject = `${trunc(sourceName, 40)} mentioned you in ${filename} (${trunc(
    projectTitle,
    50,
  )})`;
  return `${trunc(subject, MAX_SUBJECT_LENGTH)}`;
}

export function mentionPathLabel(path: string): string {
  const tail = path_split(path).tail || path;
  return `${trunc_middle(tail, 40)}`;
}
