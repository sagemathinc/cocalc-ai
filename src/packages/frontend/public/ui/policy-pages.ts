/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const POLICY_PAGES_MODES = ["none", "custom", "sagemathinc"] as const;

export type PolicyPagesMode = (typeof POLICY_PAGES_MODES)[number];

interface PublicPolicyConfig {
  policy_pages?: string;
}

export function getPolicyPagesMode(
  config?: PublicPolicyConfig,
): PolicyPagesMode {
  if (config?.policy_pages === "custom") return "custom";
  if (config?.policy_pages === "sagemathinc") return "sagemathinc";
  return "none";
}
