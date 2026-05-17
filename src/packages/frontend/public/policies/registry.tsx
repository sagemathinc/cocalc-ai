/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { publicPath } from "../routes";
import accessibilityPolicy from "./accessibility";
import copyrightPolicy from "./copyright";
import dpaPolicy from "./dpa";
import ferpaPolicy from "./ferpa";
import { getPolicyNavLabel, PolicyDocument, type PublicPolicy } from "./policy";
import privacyPolicy from "./privacy";
import termsPolicy from "./terms";
import trustPolicy from "./trust";

export const BUILTIN_POLICIES = [
  termsPolicy,
  privacyPolicy,
  dpaPolicy,
  trustPolicy,
  accessibilityPolicy,
  copyrightPolicy,
  ferpaPolicy,
] satisfies readonly PublicPolicy[];

const BUILTIN_POLICY_BY_SLUG = Object.fromEntries(
  BUILTIN_POLICIES.map((policy) => [policy.slug, policy]),
) as Record<string, PublicPolicy>;

export function BuiltinPolicyPage({ slug }: { slug?: string }) {
  const policy = slug == null ? undefined : BUILTIN_POLICY_BY_SLUG[slug];
  if (policy == null) {
    return null;
  }
  return <PolicyDocument policy={policy} />;
}

export function getBuiltinPolicy(
  slug?: string,
): PublicPolicy | undefined {
  if (slug == null) return;
  return BUILTIN_POLICY_BY_SLUG[slug];
}

export function getBuiltinPolicyNavItems() {
  return BUILTIN_POLICIES.map((policy) => ({
    href: publicPath(`policies/${policy.slug}`),
    key: policy.slug,
    label: getPolicyNavLabel(policy),
  }));
}
