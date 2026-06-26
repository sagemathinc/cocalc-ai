/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import type { ProjectCryptominingEvidence } from "@cocalc/conat/hub/api/system";
import {
  banClusterAccountAndEquivalentEmails,
  getClusterAccountById,
} from "@cocalc/server/inter-bay/accounts";
import { resolveMembershipForAccount } from "./resolve";

const logger = getLogger("server:membership:cryptomining-abuse");
const DEFAULT_NEW_ACCOUNT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ProjectCryptominingAbuseDecision {
  should_stop_project: boolean;
  auto_banned: boolean;
  membership_class?: string;
  membership_source?: string;
  account_age_ms?: number;
  ban_error?: string;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = `${process.env[name] ?? ""}`.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function isHighConfidenceCryptominingEvidence(
  evidence: ProjectCryptominingEvidence | undefined,
): boolean {
  return evidence?.confidence === "high" && (evidence.signals?.length ?? 0) > 0;
}

function createdTimeMs(created: unknown): number | undefined {
  if (created instanceof Date) return created.getTime();
  if (typeof created === "number" && Number.isFinite(created)) return created;
  if (typeof created === "string") {
    const value = Date.parse(created);
    return Number.isFinite(value) ? value : undefined;
  }
}

export async function handleProjectCryptominingEvidence({
  account_id,
  project_id,
  evidence,
  now = new Date(),
}: {
  account_id: string;
  project_id?: string;
  evidence?: ProjectCryptominingEvidence;
  now?: Date;
}): Promise<ProjectCryptominingAbuseDecision> {
  if (!isHighConfidenceCryptominingEvidence(evidence)) {
    return { should_stop_project: false, auto_banned: false };
  }

  const [account, membership] = await Promise.all([
    getClusterAccountById(account_id),
    resolveMembershipForAccount(account_id),
  ]);
  const createdMs = createdTimeMs(account?.created);
  const accountAgeMs =
    createdMs == null ? undefined : Math.max(0, now.getTime() - createdMs);
  const isNew =
    accountAgeMs != null &&
    accountAgeMs <=
      positiveIntEnv(
        "COCALC_CRYPTOMINING_AUTO_BAN_ACCOUNT_MAX_AGE_MS",
        DEFAULT_NEW_ACCOUNT_MAX_AGE_MS,
      );
  const isFree = membership.class === "free" && membership.source === "free";
  const shouldAutoBan = !account?.banned && isNew && isFree;

  if (!shouldAutoBan) {
    logger.warn("high-confidence cryptomining detected; stopping project", {
      account_id,
      project_id,
      membership_class: membership.class,
      membership_source: membership.source,
      account_age_ms: accountAgeMs,
      already_banned: account?.banned === true,
      signal_count: evidence?.signals?.length ?? 0,
      auto_banned: false,
    });
    return {
      should_stop_project: true,
      auto_banned: false,
      membership_class: membership.class,
      membership_source: membership.source,
      account_age_ms: accountAgeMs,
    };
  }

  try {
    await banClusterAccountAndEquivalentEmails({
      account_id,
      actor_account_id: null,
      reason: "automatic high-confidence cryptomining detection",
      metadata: {
        automatic: true,
        detector: "cryptomining-abuse-v1",
        project_id: project_id ?? null,
        evidence,
        membership_class: membership.class,
        membership_source: membership.source,
        account_age_ms: accountAgeMs ?? null,
      },
    });
    logger.warn("auto-banned new free account for cryptomining", {
      account_id,
      project_id,
      membership_class: membership.class,
      membership_source: membership.source,
      account_age_ms: accountAgeMs,
      signal_count: evidence?.signals?.length ?? 0,
    });
    return {
      should_stop_project: true,
      auto_banned: true,
      membership_class: membership.class,
      membership_source: membership.source,
      account_age_ms: accountAgeMs,
    };
  } catch (err) {
    logger.warn("failed to auto-ban account for cryptomining", {
      account_id,
      project_id,
      err: `${err}`,
    });
    return {
      should_stop_project: true,
      auto_banned: false,
      membership_class: membership.class,
      membership_source: membership.source,
      account_age_ms: accountAgeMs,
      ban_error: `${err}`,
    };
  }
}

export const __test__ = {
  createdTimeMs,
};
