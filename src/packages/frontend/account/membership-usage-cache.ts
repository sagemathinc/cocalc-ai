/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  AccountUsageOverview,
  AIUsageStatus,
  MembershipDetails,
} from "@cocalc/conat/hub/api/purchases";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  dispatchAccountUsageOverviewRefreshed,
  dispatchMembershipDetailsRefreshed,
} from "./membership-usage-events";

const WARNING_CACHE_MS = 45_000;
const WARNING_JITTER_MS = 15_000;

type CacheEntry<T> = {
  value: T;
  time: number;
};

let membershipDetailsCache: CacheEntry<MembershipDetails> | undefined;
let membershipDetailsInflight: Promise<MembershipDetails | null> | undefined;
let accountUsageOverviewCache: CacheEntry<AccountUsageOverview> | undefined;
let accountUsageOverviewInflight:
  | Promise<AccountUsageOverview | null>
  | undefined;
let aiUsageCache: CacheEntry<AIUsageStatus> | undefined;
let aiUsageInflight: Promise<AIUsageStatus | null> | undefined;

function isFresh<T>(entry: CacheEntry<T> | undefined, now: number): boolean {
  return entry != null && now - entry.time < WARNING_CACHE_MS;
}

export function shouldPollUsageWarnings(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

export function warningPollInterval(baseMs: number): number {
  return baseMs + Math.floor(Math.random() * WARNING_JITTER_MS);
}

export async function getWarningMembershipDetails(): Promise<MembershipDetails | null> {
  const now = Date.now();
  if (isFresh(membershipDetailsCache, now)) {
    return membershipDetailsCache!.value;
  }
  if (membershipDetailsInflight != null) {
    return await membershipDetailsInflight;
  }
  membershipDetailsInflight = webapp_client.conat_client.hub.purchases
    .getMembershipDetails({
      refresh_usage_status: true,
    })
    .then((details) => {
      const next = (details as MembershipDetails) ?? null;
      if (next != null) {
        membershipDetailsCache = { value: next, time: Date.now() };
        dispatchMembershipDetailsRefreshed(next);
      }
      return next;
    })
    .finally(() => {
      membershipDetailsInflight = undefined;
    });
  return await membershipDetailsInflight;
}

export async function getWarningAccountUsageOverview(): Promise<AccountUsageOverview | null> {
  const now = Date.now();
  if (isFresh(accountUsageOverviewCache, now)) {
    return accountUsageOverviewCache!.value;
  }
  if (accountUsageOverviewInflight != null) {
    return await accountUsageOverviewInflight;
  }
  accountUsageOverviewInflight = webapp_client.conat_client.hub.purchases
    .getAccountUsageOverview()
    .then((overview) => {
      const next = (overview as AccountUsageOverview) ?? null;
      if (next != null) {
        accountUsageOverviewCache = { value: next, time: Date.now() };
        dispatchAccountUsageOverviewRefreshed(next);
      }
      return next;
    })
    .finally(() => {
      accountUsageOverviewInflight = undefined;
    });
  return await accountUsageOverviewInflight;
}

export async function getWarningAIUsage(): Promise<AIUsageStatus | null> {
  const now = Date.now();
  if (isFresh(aiUsageCache, now)) {
    return aiUsageCache!.value;
  }
  if (aiUsageInflight != null) {
    return await aiUsageInflight;
  }
  aiUsageInflight = webapp_client.conat_client.hub.purchases
    .getAIUsage({})
    .then((status) => {
      const next = (status as AIUsageStatus) ?? null;
      if (next != null) {
        aiUsageCache = { value: next, time: Date.now() };
      }
      return next;
    })
    .finally(() => {
      aiUsageInflight = undefined;
    });
  return await aiUsageInflight;
}
