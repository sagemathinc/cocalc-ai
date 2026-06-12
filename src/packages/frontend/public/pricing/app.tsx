/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

import { type PublicConfig, PublicSectionShell } from "../common";
import PricingPage from "./page";

export default function PublicPricingApp({
  config,
}: {
  config?: PublicConfig;
}) {
  const title = "CoCalc.ai Pricing and Licensing";

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <PublicSectionShell active="pricing" config={config} title={title}>
      <PricingPage isAuthenticated={!!config?.is_authenticated} />
    </PublicSectionShell>
  );
}
