/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import TTLCache from "@isaacs/ttlcache";
import { createHash } from "crypto";
import getLogger from "@cocalc/backend/logger";
import * as metrics from "@cocalc/backend/metrics";
import centralLog from "@cocalc/database/postgres/central-log";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  evaluateSignupEmailDomainPolicy,
  extractEmailDomain,
  normalizeSignupEmailDomainPolicy,
  type SignupEmailDomainPolicyDecision,
} from "@cocalc/util/accounts/signup-email-domain-policy";

const logger = getLogger("accounts:signup-email-domain-policy");

const BLOCK_LOG_SUPPRESSION_MS = 5 * 60 * 1000;

const blockedLogCache = new TTLCache<string, true>({
  ttl: BLOCK_LOG_SUPPRESSION_MS,
});

type SignupEmailDomainPolicyMetrics = {
  allowed?: any;
  blocked?: any;
};

let signupEmailDomainPolicyMetrics: SignupEmailDomainPolicyMetrics | undefined;

function getSignupEmailDomainPolicyMetrics(): SignupEmailDomainPolicyMetrics {
  if (signupEmailDomainPolicyMetrics != null) {
    return signupEmailDomainPolicyMetrics;
  }
  try {
    signupEmailDomainPolicyMetrics = {
      allowed: metrics.newCounter(
        "server",
        "signup_domain_policy_allowed_total",
        "Signup email domain policy allowed decisions.",
        ["mode", "domain_category"],
      ),
      blocked: metrics.newCounter(
        "server",
        "signup_domain_policy_blocked_total",
        "Signup email domain policy blocked decisions.",
        ["mode", "domain_category"],
      ),
    };
  } catch (err) {
    logger.debug(`signup domain policy metrics unavailable: ${err}`);
    signupEmailDomainPolicyMetrics = {};
  }
  return signupEmailDomainPolicyMetrics;
}

function domainCategory(email_address: string): string {
  const domain = extractEmailDomain(email_address);
  if (!domain) {
    return "missing";
  }
  return `sha256-${createHash("sha256").update(domain).digest("hex").slice(0, 2)}`;
}

function recordAllowedDecision({
  mode,
  domain_category,
}: {
  mode: string;
  domain_category: string;
}): void {
  getSignupEmailDomainPolicyMetrics()
    .allowed?.labels(mode, domain_category)
    .inc();
}

function recordBlockedDecision({
  mode,
  domain_category,
  public_details_allowed,
}: {
  mode: string;
  domain_category: string;
  public_details_allowed: boolean;
}): void {
  getSignupEmailDomainPolicyMetrics()
    .blocked?.labels(mode, domain_category)
    .inc();

  const logKey = `${mode}:${domain_category}:${public_details_allowed}`;
  if (blockedLogCache.has(logKey)) {
    return;
  }
  blockedLogCache.set(logKey, true);
  void centralLog({
    event: "signup_email_domain_policy_blocked",
    value: {
      mode,
      domain_category,
      public_details_allowed,
      suppression_window_ms: BLOCK_LOG_SUPPRESSION_MS,
    },
  }).catch((err) => {
    logger.warn("failed to log signup email domain policy block", { err });
  });
}

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
  const settings = await getServerSettings();
  const policy = normalizeSignupEmailDomainPolicy(settings);
  const decision = evaluateSignupEmailDomainPolicy({
    email_address: email,
    settings,
  });
  const category = domainCategory(email);
  if (!decision.allowed) {
    recordBlockedDecision({
      mode: decision.mode,
      domain_category: category,
      public_details_allowed: decision.publicDetailsAllowed,
    });
    throw new SignupEmailDomainPolicyError(decision);
  }
  recordAllowedDecision({
    mode: policy.mode,
    domain_category: category,
  });
}
