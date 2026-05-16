/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ComponentType } from "react";

import { publicPath } from "../routes";
import AccessibilityPage from "./accessibility";
import CopyrightPage from "./copyright";
import DPAPage from "./dpa";
import FERPAPage from "./ferpa";
import PrivacyPage from "./privacy";
import TermsOfServicePage from "./terms";
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
    description: "The core terms governing use of CoCalc and related services.",
    navLabel: "Terms",
    slug: "terms",
    title: "Terms of Service",
  },
  {
    component: PrivacyPage,
    description:
      "How SageMath, Inc. collects, uses, and protects personal information.",
    navLabel: "Privacy",
    slug: "privacy",
    title: "Privacy Policy",
  },
  {
    component: DPAPage,
    description:
      "The terms that apply when SageMath, Inc. processes personal data on a user's behalf.",
    navLabel: "DPA",
    slug: "dpa",
    title: "Data Processing Addendum",
  },
  {
    component: TrustPage,
    description:
      "Security, GDPR, SOC 2, and external trust resources.",
    navLabel: "Trust",
    slug: "trust",
    title: "Trust and Compliance",
  },
  {
    component: AccessibilityPage,
    description:
      "Accessibility information, including VPAT-related material.",
    navLabel: "Accessibility",
    slug: "accessibility",
    title: "Accessibility Statement",
  },
  {
    component: CopyrightPage,
    description:
      "How SageMath, Inc. handles copyright complaints and DMCA notices.",
    navLabel: "Copyright",
    slug: "copyright",
    title: "Copyright Policy",
  },
  {
    component: FERPAPage,
    description:
      "How CoCalc addresses FERPA-related questions for educational institutions.",
    navLabel: "FERPA",
    slug: "ferpa",
    title: "FERPA Statement",
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
