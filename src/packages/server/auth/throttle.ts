/*
Some simple sign in throttling to reduce the impact of brute force
attacks.  This is in memory per-backend server, and doesn't touch
the database.
*/

import getStrategies from "@cocalc/database/settings/get-sso-strategies";
import LRU from "lru-cache";
import { checkRequiredSSO, getEmailDomain } from "./sso/check-required-sso";
import centralLog from "@cocalc/database/postgres/central-log";
import type { Strategy } from "@cocalc/util/types/sso";

const emailShortCache = new LRU<string, number>({
  max: 10000, // avoid memory issues
  ttl: 1000 * 60,
});
const emailLongCache = new LRU<string, number>({
  max: 20000,
  ttl: 1000 * 60 * 60,
});
const ipShortCache = new LRU<string, number>({ max: 10000, ttl: 1000 * 60 });
const ipLongCache = new LRU<string, number>({
  max: 20000,
  ttl: 1000 * 60 * 60,
});
const signupTokenEmailShortCache = new LRU<string, number>({
  max: 10000,
  ttl: 1000 * 60,
});
const signupTokenEmailLongCache = new LRU<string, number>({
  max: 20000,
  ttl: 1000 * 60 * 60,
});
const signupTokenIpShortCache = new LRU<string, number>({
  max: 10000,
  ttl: 1000 * 60,
});
const signupTokenIpLongCache = new LRU<string, number>({
  max: 20000,
  ttl: 1000 * 60 * 60,
});

async function isExclusiveEmail(email: string) {
  const strategies = await getStrategies();
  return checkRequiredSSO({ email, strategies });
}

async function logSsoRequiredPasswordBlock({
  email,
  ip,
  strategy,
}: {
  email: string;
  ip?: string;
  strategy: Strategy;
}): Promise<void> {
  try {
    await centralLog({
      event: "sso_required_password_sign_in_blocked",
      value: {
        strategy: strategy.name,
        display: strategy.display,
        email_domain: getEmailDomain(email),
        ip_address: ip,
      },
    });
  } catch {
    // Sign-in throttling must not depend on telemetry availability.
  }
}

export async function signInCheck(
  email: string,
  ip?: string,
): Promise<string | undefined> {
  if ((emailShortCache.get(email) ?? 0) > 5) {
    // A given email address is allowed at most 5 failed login attempts per minute
    return `Too many attempts per minute to sign in as "${email}". Wait one minute, then try again.`;
  }
  if ((emailLongCache.get(email) ?? 0) > 50) {
    // A given email address is allowed at most 50 failed login attempts per hour.
    return `Too many attempts per hour to sign in as "${email}". Wait about an hour, then try again.`;
  }

  if (ip != null && (ipShortCache.get(ip) ?? 0) > 30) {
    // A given ip address is allowed at most 30 failed login attempts per minute.
    return `Too many attempts per minute to sign in from your computer. Wait one minute, then try again.`;
  }
  if (ip != null && (ipLongCache.get(ip) ?? 0) > 200) {
    // A given ip address is allowed at most 200 failed login attempts per hour.
    return `Too many attempts per hour to sign in from your computer. Wait about an hour, then try again.`;
  }
  const exclusiveSSO = await isExclusiveEmail(email);
  if (exclusiveSSO != null) {
    const name = exclusiveSSO.display ?? exclusiveSSO.name;
    await logSsoRequiredPasswordBlock({
      email,
      ip,
      strategy: exclusiveSSO,
    });
    return `You have to sign in using the Single-Sign-On mechanism "${name}" of your institution.`;
  }
}

export function recordFail(email: string, ip?: string): void {
  emailShortCache.set(email, (emailShortCache.get(email) ?? 0) + 1);
  emailLongCache.set(email, (emailLongCache.get(email) ?? 0) + 1);
  if (ip != null) {
    ipShortCache.set(ip, (ipShortCache.get(ip) ?? 0) + 1);
    ipLongCache.set(ip, (ipLongCache.get(ip) ?? 0) + 1);
  }
}

export function signUpTokenCheck(
  email: string,
  ip?: string,
): string | undefined {
  if ((signupTokenEmailShortCache.get(email) ?? 0) > 5) {
    return `Too many failed registration-token attempts for "${email}". Wait one minute, then try again.`;
  }
  if ((signupTokenEmailLongCache.get(email) ?? 0) > 50) {
    return `Too many failed registration-token attempts for "${email}". Wait about an hour, then try again.`;
  }
  if (ip != null && (signupTokenIpShortCache.get(ip) ?? 0) > 20) {
    return "Too many failed registration-token attempts from your computer. Wait one minute, then try again.";
  }
  if (ip != null && (signupTokenIpLongCache.get(ip) ?? 0) > 100) {
    return "Too many failed registration-token attempts from your computer. Wait about an hour, then try again.";
  }
}

export function recordSignUpTokenFail(email: string, ip?: string): void {
  signupTokenEmailShortCache.set(
    email,
    (signupTokenEmailShortCache.get(email) ?? 0) + 1,
  );
  signupTokenEmailLongCache.set(
    email,
    (signupTokenEmailLongCache.get(email) ?? 0) + 1,
  );
  if (ip != null) {
    signupTokenIpShortCache.set(ip, (signupTokenIpShortCache.get(ip) ?? 0) + 1);
    signupTokenIpLongCache.set(ip, (signupTokenIpLongCache.get(ip) ?? 0) + 1);
  }
}
