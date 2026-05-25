/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  evaluateSignupEmailDomainPolicy,
  type SignupEmailDomainPolicyDecision,
} from "@cocalc/util/accounts/signup-email-domain-policy";

export class SignupEmailDomainPolicyError extends Error {
  public readonly mode: Exclude<
    SignupEmailDomainPolicyDecision,
    { allowed: true }
  >["mode"];
  public readonly publicDetailsAllowed: boolean;

  constructor(
    decision: Exclude<SignupEmailDomainPolicyDecision, { allowed: true }>,
  ) {
    super(decision.publicMessage);
    this.name = "SignupEmailDomainPolicyError";
    this.mode = decision.mode;
    this.publicDetailsAllowed = decision.publicDetailsAllowed;
  }
}

export async function assertSignupEmailDomainAllowed({
  email_address,
}: {
  email_address?: string | null;
}): Promise<void> {
  const email = `${email_address ?? ""}`.trim().toLowerCase();
  if (!email) {
    return;
  }
  const decision = evaluateSignupEmailDomainPolicy({
    email_address: email,
    settings: await getServerSettings(),
  });
  if (!decision.allowed) {
    throw new SignupEmailDomainPolicyError(decision);
  }
}
