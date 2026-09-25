/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ProjectOnboardingIntent } from "@cocalc/util/accounts/onboarding-intent";

export type EmailAuthPurpose = "sign_in_or_sign_up" | "email_fresh_auth";

export class EmailAuthChallengeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "blocked"
      | "expired"
      | "invalid"
      | "not_allowed"
      | "not_found"
      | "rate_limited"
      | "resend_too_soon",
  ) {
    super(message);
    this.name = "EmailAuthChallengeError";
  }
}

export type EmailAuthChallengeState =
  | "pending"
  | "email_proved"
  | "account_creating"
  | "account_ready"
  | "mfa_required"
  | "completed"
  | "superseded"
  | "expired"
  | "blocked"
  | "failed";

export interface EmailAuthChallengePublicStatus {
  challenge_id: string;
  purpose: EmailAuthPurpose;
  state: EmailAuthChallengeState;
  account_created: boolean;
  masked_email: string;
  expires_at: string;
  resend_available_at: string;
  send_count: number;
  message_sent: boolean;
  message_failed: boolean;
  message_sent_now: boolean;
}

export interface StartEmailAuthChallengeOptions {
  email_address: string;
  browser_binding: string;
  request_ip?: string;
  registration_token?: string;
  analytics_token?: string;
  purpose?: EmailAuthPurpose;
  prospective_home_bay_id?: string;
  terms_accepted?: boolean;
  terms_version?: string;
  continuation_target?: string;
  onboarding_intent?: ProjectOnboardingIntent;
  expected_account_id?: string;
  code_only?: boolean;
}

export interface GetEmailAuthChallengeStatusOptions {
  challenge_id: string;
  browser_binding: string;
}

export interface ResendEmailAuthChallengeOptions extends GetEmailAuthChallengeStatusOptions {}

export interface RedeemEmailAuthCodeOptions {
  challenge_id: string;
  code: string;
  browser_binding?: string;
}

export interface RedeemEmailAuthLinkOptions {
  challenge_id: string;
  token: string;
  browser_binding?: string;
}

export interface PrepareEmailAuthExchangeOptions {
  challenge_id: string;
  auth_method: "email_code" | "email_link";
}

export interface EmailAuthExchangeResult {
  challenge_id: string;
  account_created: boolean;
  exchange_token: string;
  exchange_expires_at: string;
  home_bay_id: string;
  redirect_to?: string;
  state: "account_ready";
}

export interface ConsumeEmailAuthExchangeOptions {
  account_id: string;
  challenge_id: string;
  exchange_id: string;
  home_bay_id: string;
  completion: "completed" | "mfa_required";
}

export interface CompleteEmailAuthMfaOptions {
  account_id: string;
  challenge_id: string;
  home_bay_id: string;
}

export interface CompleteEmailFreshAuthOptions {
  account_id: string;
  challenge_id: string;
}

export interface CompletedEmailFreshAuth {
  auth_method: "email_code" | "email_link";
  email_proved_at: string;
}

export interface ConsumedEmailAuthExchange {
  account_id: string;
  auth_method: "email_code" | "email_link";
  email_proved_at: string;
}
