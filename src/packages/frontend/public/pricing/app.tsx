/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";
import { getPublicPricingContent } from "@cocalc/util/public-pricing-content";

import { getSiteName, type PublicConfig, PublicSectionShell } from "../common";
import PricingPage from "./page";

export default function PublicPricingApp({
  config,
}: {
  config?: PublicConfig;
}) {
  const siteName = getSiteName(config);
  const content = getPublicPricingContent(config?.cocalc_product);
  const title = `${content.pageTitle} – ${siteName}`;

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <PublicSectionShell
      active="pricing"
      config={config}
      title={content.pageTitle}
    >
      <PricingPage
        cocalcProduct={config?.cocalc_product}
        helpEmail={config?.help_email}
        isAuthenticated={!!config?.is_authenticated}
        zendesk={!!config?.zendesk}
      />
    </PublicSectionShell>
  );
}
