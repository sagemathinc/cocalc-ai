/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const SIGNUP_EMAIL_DOMAIN_POLICY_MODES = [
  "allow_all",
  "allow_only",
  "deny_list",
] as const;

export type SignupEmailDomainPolicyMode =
  (typeof SIGNUP_EMAIL_DOMAIN_POLICY_MODES)[number];

export type SignupEmailDomainPolicySettings = {
  signup_email_domain_policy_mode?: unknown;
  signup_email_domain_allow_list?: unknown;
  signup_email_domain_deny_list?: unknown;
  signup_email_domain_public_message?: unknown;
  signup_email_domain_show_allowed_domains?: unknown;
};

export type DomainRule = {
  domain: string;
  includeSubdomains: boolean;
};

export type SignupEmailDomainPolicy = {
  mode: SignupEmailDomainPolicyMode;
  allowRules: DomainRule[];
  denyRules: DomainRule[];
  publicMessage: string;
  showAllowedDomains: boolean;
};

export type SignupEmailDomainPolicyDecision =
  | { allowed: true }
  | {
      allowed: false;
      mode: Exclude<SignupEmailDomainPolicyMode, "allow_all">;
      publicMessage: string;
      publicDetailsAllowed: boolean;
    };

export type SignupEmailDomainPublicPolicy = {
  mode: SignupEmailDomainPolicyMode;
  message?: string;
  allowed_domains?: string[];
};

export const SIGNUP_EMAIL_DOMAIN_POLICY_SETTING_KEYS = new Set([
  "signup_email_domain_policy_mode",
  "signup_email_domain_allow_list",
  "signup_email_domain_deny_list",
  "signup_email_domain_public_message",
  "signup_email_domain_show_allowed_domains",
]);

const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseDomainRules(value: unknown): DomainRule[] {
  const raw =
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? value
      : asString(value).split(/[\s,;]+/);
  const rules = new Map<string, DomainRule>();
  for (const entry of raw) {
    let domain = `${entry ?? ""}`.trim().toLowerCase();
    if (!domain) continue;
    let includeSubdomains = false;
    if (domain.startsWith("*.")) {
      includeSubdomains = true;
      domain = domain.slice(2);
    }
    if (domain.startsWith("@")) {
      domain = domain.slice(1);
    }
    domain = domain.replace(/\.+$/, "");
    const labels = domain.split(".");
    if (
      !domain ||
      labels.length === 0 ||
      labels.some((label) => !DOMAIN_LABEL_RE.test(label))
    ) {
      continue;
    }
    rules.set(`${includeSubdomains ? "*." : ""}${domain}`, {
      domain,
      includeSubdomains,
    });
  }
  return [...rules.values()];
}

export function normalizeSignupEmailDomainPolicy(
  settings: SignupEmailDomainPolicySettings,
): SignupEmailDomainPolicy {
  const rawMode = asString(settings.signup_email_domain_policy_mode);
  const mode = SIGNUP_EMAIL_DOMAIN_POLICY_MODES.includes(rawMode as any)
    ? (rawMode as SignupEmailDomainPolicyMode)
    : "allow_all";
  return {
    mode,
    allowRules: parseDomainRules(settings.signup_email_domain_allow_list),
    denyRules: parseDomainRules(settings.signup_email_domain_deny_list),
    publicMessage: asString(settings.signup_email_domain_public_message),
    showAllowedDomains:
      settings.signup_email_domain_show_allowed_domains === true ||
      asString(settings.signup_email_domain_show_allowed_domains) === "yes" ||
      asString(settings.signup_email_domain_show_allowed_domains) === "true",
  };
}

export function extractEmailDomain(emailAddress: string): string {
  const email = `${emailAddress ?? ""}`.trim().toLowerCase();
  const i = email.lastIndexOf("@");
  return i >= 0 ? email.slice(i + 1).replace(/\.+$/, "") : "";
}

export function domainMatchesRule(domain: string, rule: DomainRule): boolean {
  const normalized = `${domain ?? ""}`.trim().toLowerCase();
  return (
    normalized === rule.domain ||
    (rule.includeSubdomains && normalized.endsWith(`.${rule.domain}`))
  );
}

export function domainMatchesRules(
  domain: string,
  rules: readonly DomainRule[],
): boolean {
  return rules.some((rule) => domainMatchesRule(domain, rule));
}

function displayDomainRule(rule: DomainRule): string {
  return `${rule.includeSubdomains ? "*." : "@"}${rule.domain}`;
}

function allowedDomainsMessage(rules: readonly DomainRule[]): string {
  const domains = rules.map(displayDomainRule);
  if (domains.length === 0) {
    return "Use an approved email address to create an account.";
  }
  return `Use an approved email address: ${domains.join(", ")}.`;
}

export function evaluateSignupEmailDomainPolicy({
  email_address,
  settings,
}: {
  email_address: string;
  settings: SignupEmailDomainPolicySettings;
}): SignupEmailDomainPolicyDecision {
  const policy = normalizeSignupEmailDomainPolicy(settings);
  const domain = extractEmailDomain(email_address);
  if (!domain || policy.mode === "allow_all") {
    return { allowed: true };
  }
  if (policy.mode === "allow_only") {
    if (domainMatchesRules(domain, policy.allowRules)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      mode: "allow_only",
      publicDetailsAllowed: true,
      publicMessage:
        policy.publicMessage ||
        (policy.showAllowedDomains
          ? allowedDomainsMessage(policy.allowRules)
          : "Use an approved email address to create an account."),
    };
  }
  if (domainMatchesRules(domain, policy.denyRules)) {
    return {
      allowed: false,
      mode: "deny_list",
      publicDetailsAllowed: !!policy.publicMessage,
      publicMessage:
        policy.publicMessage ||
        "Account creation is not available for this email address. Use a different email address or contact support.",
    };
  }
  return { allowed: true };
}

export function publicSignupEmailDomainPolicy(
  settings: SignupEmailDomainPolicySettings,
): SignupEmailDomainPublicPolicy {
  const policy = normalizeSignupEmailDomainPolicy(settings);
  if (policy.mode === "allow_only") {
    const allowed_domains = policy.showAllowedDomains
      ? policy.allowRules.map(displayDomainRule)
      : undefined;
    return {
      mode: "allow_only",
      message:
        policy.publicMessage ||
        (policy.showAllowedDomains
          ? allowedDomainsMessage(policy.allowRules)
          : "Use an approved email address to create an account."),
      allowed_domains,
    };
  }
  if (policy.mode === "deny_list" && policy.publicMessage) {
    return {
      mode: "deny_list",
      message: policy.publicMessage,
    };
  }
  return { mode: policy.mode };
}

export function emailAllowedByPublicSignupPolicy({
  email_address,
  policy,
}: {
  email_address: string;
  policy?: SignupEmailDomainPublicPolicy;
}): boolean {
  if (policy?.mode !== "allow_only" || !policy.allowed_domains?.length) {
    return true;
  }
  const domain = extractEmailDomain(email_address);
  return domainMatchesRules(domain, parseDomainRules(policy.allowed_domains));
}
