/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ComponentType } from "react";

import { publicPath } from "../routes";
import AccessibilityPage from "./accessibility";
import CopyrightPage from "./copyright";
import EnterpriseTermsPage from "./enterprise-terms";
import FERPAPage from "./ferpa";
import PrivacyPage from "./privacy";
import TermsOfServicePage from "./terms";
import ThirdPartiesPage from "./thirdparties";
import TrustPage from "./trust";

export interface BuiltinPolicyEntry {
  component: ComponentType;
  description: string;
  navLabel: string;
  slug: string;
  title: string;
}

export const BUILTIN_POLICIES: readonly BuiltinPolicyEntry[] = [
  {
    component: TermsOfServicePage,
    description: "The Terms of Service govern use of CoCalc.",
    navLabel: "Terms",
    slug: "terms",
    title: "Terms of Service",
  },
  {
    component: PrivacyPage,
    description:
      "The Privacy Policy describes how SageMath, Inc. respects the privacy of its users.",
    navLabel: "Privacy",
    slug: "privacy",
    title: "Privacy Policy",
  },
  {
    component: ThirdPartiesPage,
    description:
      "Our List of third parties enumerates what is used to provide CoCalc.",
    navLabel: "Third Parties",
    slug: "thirdparties",
    title: "Third Parties",
  },
  {
    component: TrustPage,
    description:
      "The Trust page highlights our compliance with laws and frameworks, such as GDPR and SOC 2. We adhere to rigorous standards to protect your data and maintain transparency and accountability in all our operations.",
    navLabel: "Trust",
    slug: "trust",
    title: "Trust",
  },
  {
    component: EnterpriseTermsPage,
    description: "Enterprise and institutional agreement overview.",
    navLabel: "Enterprise",
    slug: "enterprise-terms",
    title: "Enterprise Terms",
  },
  {
    component: AccessibilityPage,
    description:
      "CoCalc's Voluntary Product Accessibility Template (VPAT) describes how we address accessibility issues.",
    navLabel: "Accessibility",
    slug: "accessibility",
    title: "Accessibility Statement",
  },
  {
    component: CopyrightPage,
    description:
      "The Copyright Policy explains how SageMath, Inc. respects copyright policies, and provides a site that does not infringe on others' copyright.",
    navLabel: "Copyright",
    slug: "copyright",
    title: "Copyright Policy",
  },
  {
    component: FERPAPage,
    description:
      "CoCalc's FERPA Compliance statement explains how we address FERPA requirements at US educational instituations.",
    navLabel: "FERPA",
    slug: "ferpa",
    title: "FERPA Compliance Statement",
  },
] as const;

const BUILTIN_POLICY_BY_SLUG = Object.fromEntries(
  BUILTIN_POLICIES.map((policy) => [policy.slug, policy]),
) as Record<string, BuiltinPolicyEntry>;

export function BuiltinPolicyPage({ slug }: { slug?: string }) {
  const entry = slug == null ? undefined : BUILTIN_POLICY_BY_SLUG[slug];
  if (entry == null) {
    return null;
  }
  const Component = entry.component;
  return <Component />;
}

export function getBuiltinPolicy(
  slug?: string,
): BuiltinPolicyEntry | undefined {
  if (slug == null) return;
  return BUILTIN_POLICY_BY_SLUG[slug];
}

export function getBuiltinPolicyNavItems() {
  return BUILTIN_POLICIES.map((policy) => ({
    href: publicPath(`policies/${policy.slug}`),
    key: policy.slug,
    label: policy.navLabel,
  }));
}
