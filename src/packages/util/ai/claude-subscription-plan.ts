/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// Deliberately do not infer entitlement from an unfamiliar provider plan name.
export function isSupportedClaudeSubscriptionPlan(
  plan: unknown,
): plan is string {
  return (
    typeof plan === "string" &&
    /^(?:claude\s+)?(?:pro|max)(?:\s|$)/i.test(plan.trim())
  );
}

export const CLAUDE_SUBSCRIPTION_PLAN_ERROR =
  "Unsupported Claude subscription plan. This integration currently supports verified Claude Pro/Max only; Team, Enterprise, and unrecognized plans are not supported. Use an Anthropic API key instead.";
