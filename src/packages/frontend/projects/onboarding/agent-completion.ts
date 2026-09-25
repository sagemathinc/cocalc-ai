/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { markFirstRunCompletedThisSession } from "@cocalc/frontend/app/onboarding-session";
import { getLogger } from "@cocalc/frontend/logger";
import {
  FIRST_RUN_ONBOARDING_SETTING,
  FIRST_RUN_ONBOARDING_VERSION,
  normalizeStoredFirstRunOnboarding,
  type StoredFirstRunOnboarding,
} from "./state";

const logger = getLogger("projects:onboarding:agent-completion");
const AGENT_FIRST_RUN_KEY = "cocalc:agent-first-run:";
const activeFirstRuns = new Set<string>();

export function beginAgentFirstRun(accountId: string): void {
  activeFirstRuns.add(accountId);
  try {
    globalThis.sessionStorage?.setItem(
      `${AGENT_FIRST_RUN_KEY}${accountId}`,
      "1",
    );
  } catch {
    // Session storage is only used to scope the completion update.
  }
}

export async function completeFirstRunWithAgent(
  accountId: string | undefined,
  projectId: string,
): Promise<void> {
  if (!accountId) return;
  const key = `${AGENT_FIRST_RUN_KEY}${accountId}`;
  let started = activeFirstRuns.has(accountId);
  try {
    started ||= globalThis.sessionStorage?.getItem(key) === "1";
  } catch {
    // In-memory state still covers the current page when storage is disabled.
  }
  if (!started) return;
  const clearStarted = () => {
    activeFirstRuns.delete(accountId);
    try {
      globalThis.sessionStorage?.removeItem(key);
    } catch {
      // Nothing else to clean up when storage is disabled.
    }
  };
  const account = redux.getStore("account");
  const saved = normalizeStoredFirstRunOnboarding(
    account?.getIn(["other_settings", FIRST_RUN_ONBOARDING_SETTING]),
  );
  if (
    saved?.status === "completed" ||
    saved?.status === "dismissed" ||
    (saved?.status === "in_progress" &&
      (saved.intent === "course-invite" || saved.intent === "project-invite"))
  ) {
    clearStarted();
    return;
  }
  markFirstRunCompletedThisSession();
  const value: StoredFirstRunOnboarding = {
    version: FIRST_RUN_ONBOARDING_VERSION,
    status: "completed",
    intent: "codex",
    project_id: projectId,
    updated_at: new Date().toISOString(),
  };
  try {
    await redux
      .getActions("account")
      .set_other_settings_and_wait(FIRST_RUN_ONBOARDING_SETTING, value);
    clearStarted();
  } catch (err) {
    logger.warn("failed to persist agent onboarding completion", {
      err: `${err}`,
    });
  }
}
