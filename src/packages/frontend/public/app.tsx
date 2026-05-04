/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Suspense, lazy, useEffect, useState } from "react";

import { Button, Typography } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getSiteName, type PublicConfig, PublicSectionShell } from "./common";
import type { PublicRoute } from "./routes";
import PublicHomeApp from "./home/app";
import { joinUrlPath } from "@cocalc/util/url-path";
import { publicPath } from "./routes";

const PublicAboutApp = lazy(() => import("./about/app"));
const PublicAuthApp = lazy(() => import("./auth/app"));
const PublicFeaturesApp = lazy(() => import("./features/app"));
const PublicLangApp = lazy(() => import("./lang/app"));
const PublicNewsApp = lazy(() => import("./news/app"));
const PublicPoliciesApp = lazy(() => import("./policies/app"));
const PublicPricingApp = lazy(() => import("./pricing/app"));
const PublicProductsApp = lazy(() => import("./products/app"));
const PublicSupportApp = lazy(() => import("./support/app"));
const { Paragraph } = Typography;

interface PublicAppProps {
  config?: PublicConfig;
  initialRoute: PublicRoute;
  redirectToPath?: string;
}

async function loadCustomize(): Promise<PublicConfig | undefined> {
  try {
    const resp = await fetch(joinUrlPath(appBasePath, "customize"));
    const result = await resp.json();
    return result?.configuration;
  } catch {
    return undefined;
  }
}

function PublicNotFoundPage({ config }: { config?: PublicConfig }) {
  const siteName = getSiteName(config);
  const title = `Page not found - ${siteName}`;

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <PublicSectionShell config={config} title="Page not found">
      <div style={{ display: "grid", gap: 16, justifyItems: "center" }}>
        <Paragraph style={{ margin: 0, maxWidth: "56ch", textAlign: "center" }}>
          The page you requested does not exist in the public site.
        </Paragraph>
        <Button href={publicPath("")} type="primary">
          Go to Home
        </Button>
      </div>
    </PublicSectionShell>
  );
}

function PublicRouteBody({
  config,
  initialRoute,
  redirectToPath,
}: PublicAppProps) {
  if (initialRoute.section === "home") {
    return <PublicHomeApp config={config} />;
  }

  if (initialRoute.section === "about") {
    return <PublicAboutApp config={config} initialRoute={initialRoute.route} />;
  }

  if (initialRoute.section === "auth") {
    return (
      <PublicAuthApp
        config={config}
        initialRoute={initialRoute.route}
        redirectToPath={redirectToPath}
      />
    );
  }

  if (initialRoute.section === "features") {
    return (
      <PublicFeaturesApp config={config} initialRoute={initialRoute.route} />
    );
  }

  if (initialRoute.section === "lang") {
    return <PublicLangApp config={config} initialRoute={initialRoute.route} />;
  }

  if (initialRoute.section === "news") {
    return <PublicNewsApp config={config} initialRoute={initialRoute.route} />;
  }

  if (initialRoute.section === "not-found") {
    return <PublicNotFoundPage config={config} />;
  }

  if (initialRoute.section === "policies") {
    return (
      <PublicPoliciesApp config={config} initialRoute={initialRoute.route} />
    );
  }

  if (initialRoute.section === "pricing") {
    return <PublicPricingApp config={config} />;
  }

  if (initialRoute.section === "products") {
    return (
      <PublicProductsApp config={config} initialRoute={initialRoute.route} />
    );
  }

  if (initialRoute.section === "support") {
    return (
      <PublicSupportApp config={config} initialRoute={initialRoute.route} />
    );
  }

  return <div />;
}

export default function PublicApp({
  config,
  initialRoute,
  redirectToPath,
}: PublicAppProps) {
  const [resolvedConfig, setResolvedConfig] = useState(config);

  useEffect(() => {
    setResolvedConfig(config);
  }, [config]);

  useEffect(() => {
    if (config !== undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const nextConfig = await loadCustomize();
      if (!cancelled) {
        setResolvedConfig(nextConfig);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  return (
    <Suspense fallback={null}>
      <PublicRouteBody
        config={resolvedConfig}
        initialRoute={initialRoute}
        redirectToPath={redirectToPath}
      />
    </Suspense>
  );
}
