/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { contains_url } from "@cocalc/util/misc";

export const EMAIL_INVITE_URL_ERROR =
  "Email invitations cannot contain links or URLs. Remove the URL, then save the invitation.";

export function getEmailInviteValidationError(body: string): string {
  return contains_url(body) ? EMAIL_INVITE_URL_ERROR : "";
}
