/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { z } from "@cocalc/http-api/lib/api";
import { PROJECT_ONBOARDING_INTENTS } from "@cocalc/util/accounts/onboarding-intent";

export const EmailAuthChallengeStateSchema = z.enum([
  "pending",
  "email_proved",
  "account_creating",
  "account_ready",
  "mfa_required",
  "completed",
  "superseded",
  "expired",
  "blocked",
  "failed",
]);

export const EmailAuthChallengeStatusSchema = z.object({
  challenge_id: z.string().uuid(),
  purpose: z.enum(["sign_in_or_sign_up", "email_fresh_auth"]),
  state: EmailAuthChallengeStateSchema,
  account_created: z.boolean(),
  masked_email: z.string(),
  expires_at: z.string(),
  resend_available_at: z.string(),
  send_count: z.number().int(),
  message_sent: z.boolean(),
  message_failed: z.boolean(),
  message_sent_now: z.boolean(),
});

export const EmailAuthErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});

export const EmailAuthExchangeSchema = z.object({
  challenge_id: z.string().uuid(),
  account_created: z.boolean(),
  exchange_token: z.string().min(32),
  exchange_expires_at: z.string(),
  home_bay_id: z.string().min(1),
  home_bay_url: z.string().optional(),
  redirect_to: z.string().optional(),
  state: z.literal("account_ready"),
});

export const EmailAuthStartInputSchema = z.object({
  email: z.string().email(),
  onboarding_intent: z.enum(PROJECT_ONBOARDING_INTENTS).optional(),
  // The Home page experiment version: counted once the account exists.
  home_variant: z.string().max(32).optional(),
  registration_token: z.string().max(4096).optional(),
  analytics_token: z.string().uuid().optional(),
  terms: z.boolean().optional(),
  terms_version: z.string().max(128).optional(),
  target: z.string().max(4096).optional(),
});

export const EmailAuthStartOutputSchema = z.union([
  EmailAuthChallengeStatusSchema,
  z.object({
    sso_required: z.literal(true),
    strategy: z.object({
      name: z.string(),
      display: z.string(),
    }),
  }),
  EmailAuthErrorSchema,
]);

export const EmailAuthStatusInputSchema = z.object({
  challenge_id: z.string().uuid(),
});

export const EmailAuthRedeemCodeInputSchema = EmailAuthStatusInputSchema.extend(
  {
    code: z.string().regex(/^\d{6}$/),
  },
);

export const EmailAuthRedeemLinkInputSchema = EmailAuthStatusInputSchema.extend(
  {
    token: z.string().min(32),
  },
);

export const EmailAuthChallengeOutputSchema = z.union([
  EmailAuthChallengeStatusSchema,
  EmailAuthExchangeSchema,
  EmailAuthErrorSchema,
]);

export const EmailAuthExchangeInputSchema = z.object({
  retry_token: z.string().min(32),
});
