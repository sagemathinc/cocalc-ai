/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ComponentType } from "react";

import AccessibilityPage from "./accessibility";
import CopyrightPage from "./copyright";
import EnterpriseTermsPage from "./enterprise-terms";
import FERPAPage from "./ferpa";
import PrivacyPage from "./privacy";
import ThirdPartiesPage from "./thirdparties";
import TermsOfServicePage from "./terms";
import TrustPage from "./trust";

interface ExactPolicyPageEntry {
  component: ComponentType;
  title: string;
}

const EXACT_POLICY_PAGES: Record<string, ExactPolicyPageEntry> = {
  accessibility: {
    component: AccessibilityPage,
    title: "Accessibility",
  },
  copyright: {
    component: CopyrightPage,
    title: "Copyright policy",
  },
  "enterprise-terms": {
    component: EnterpriseTermsPage,
    title: "Enterprise terms",
  },
  ferpa: {
    component: FERPAPage,
    title: "FERPA compliance statement",
  },
  privacy: {
    component: PrivacyPage,
    title: "Privacy policy",
  },
  terms: {
    component: TermsOfServicePage,
    title: "Terms of service",
  },
  thirdparties: {
    component: ThirdPartiesPage,
    title: "Third parties",
  },
  trust: {
    component: TrustPage,
    title: "Trust",
  },
};

export function ExactPolicyPage({ slug }: { slug?: string }) {
  const entry = slug == null ? undefined : EXACT_POLICY_PAGES[slug];
  if (entry == null) {
    return null;
  }
  const Component = entry.component;
  return <Component />;
}

export function getExactPolicyPage(
  slug?: string,
): ExactPolicyPageEntry | undefined {
  if (slug == null) return;
  return EXACT_POLICY_PAGES[slug];
}
