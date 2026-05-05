/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { getSiteName, type PublicConfig, PublicSectionShell } from "../common";
import PricingPage from "./page";

export default function PublicPricingApp({
  config,
}: {
  config?: PublicConfig;
}) {
  const siteName = getSiteName(config);
  const title = `${siteName} Pricing`;

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <PublicSectionShell active="pricing" config={config} title={title}>
      <PricingPage
        isAuthenticated={!!config?.is_authenticated}
        siteName={siteName}
      />
    </PublicSectionShell>
  );
}
