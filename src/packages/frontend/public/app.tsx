/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Suspense, lazy, useEffect, useRef, useState } from "react";

import { Button, Typography } from "antd";
import { getControlPlaneAuthBootstrap } from "@cocalc/frontend/auth/api";
import { receiveAppearanceBootstrap } from "@cocalc/frontend/appearance/bootstrap-account";
import {
  hasTrackingConsent,
  onConsentChange,
} from "@cocalc/frontend/cookie-consent";
import { linkFirstPartyAnalyticsAccount } from "@cocalc/frontend/cookie-consent/analytics";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";

import { getSiteName, type PublicConfig, PublicSectionShell } from "./common";
import { PublicRouteHeadMetadata } from "./metadata";
import type { PublicRoute } from "./routes";
import { publicPath } from "./routes";

const PublicAboutApp = lazy(() => import("./about/app"));
const PublicAuthApp = lazy(() => import("./auth/app"));
const PublicDocsApp = lazy(() => import("./docs/app"));
const PublicFeaturesApp = lazy(() => import("./features/app"));
const PublicGuidesApp = lazy(() => import("./guides/app"));
const PublicHomeApp = lazy(() => import("./home/app"));
const PublicLangApp = lazy(() => import("./lang/app"));
const PublicNewsApp = lazy(() => import("./news/app"));
const PublicPoliciesApp = lazy(() => import("./policies/app"));
const PublicPricingApp = lazy(() => import("./pricing/app"));
const PublicProductsApp = lazy(() => import("./products/app"));
const PublicRootfsApp = lazy(() => import("./rootfs/app"));
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
    if (!resp.ok) return undefined;
    const result = await resp.json();
    const configuration = result?.configuration;
    return configuration != null &&
      typeof configuration === "object" &&
      !Array.isArray(configuration)
      ? configuration
      : undefined;
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

  if (initialRoute.section === "docs") {
    return <PublicDocsApp config={config} initialRoute={initialRoute.route} />;
  }

  if (initialRoute.section === "features") {
    return (
      <PublicFeaturesApp config={config} initialRoute={initialRoute.route} />
    );
  }

  if (initialRoute.section === "guides") {
    return <PublicGuidesApp config={config} />;
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

  if (initialRoute.section === "rootfs") {
    return (
      <PublicRootfsApp config={config} initialRoute={initialRoute.route} />
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
  const authOverride = useRef<Partial<PublicConfig> | undefined>(undefined);
  // Auth bootstrap can populate resolvedConfig before customize returns, so it
  // does not establish the product or complete this configuration request.
  const [customizeState, setCustomizeState] = useState({
    sourceConfig: config,
    pending: config === undefined,
  });

  useEffect(() => {
    authOverride.current = undefined;
    setResolvedConfig(config);
    if (config !== undefined) {
      setCustomizeState({ sourceConfig: config, pending: false });
      return;
    }
    let cancelled = false;
    setCustomizeState({ sourceConfig: config, pending: true });
    void (async () => {
      const nextConfig = await loadCustomize();
      if (!cancelled) {
        setResolvedConfig({ ...nextConfig, ...authOverride.current });
        setCustomizeState({ sourceConfig: config, pending: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  useEffect(() => {
    if (resolvedConfig == null) return;
    if (!resolvedConfig.cookie_banner_enabled) return;
    let cancelled = false;
    void import("@cocalc/frontend/cookie-consent/init").then(
      ({ initCookieConsent }) => {
        if (cancelled) return;
        initCookieConsent({
          enabled: true,
          textMarkdown: resolvedConfig.cookie_banner_text,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [resolvedConfig]);

  useEffect(() => {
    if (
      !resolvedConfig?.cookie_banner_enabled ||
      !resolvedConfig.is_authenticated
    ) {
      return;
    }
    return onConsentChange(() => {
      if (!hasTrackingConsent()) return;
      void linkFirstPartyAnalyticsAccount();
    });
  }, [resolvedConfig?.cookie_banner_enabled, resolvedConfig?.is_authenticated]);

  useEffect(() => {
    if (initialRoute.section === "docs") {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const bootstrap = await getControlPlaneAuthBootstrap();
        if (cancelled || typeof bootstrap?.signed_in !== "boolean") return;
        receiveAppearanceBootstrap(bootstrap);
        const auth = {
          account_display_name: bootstrap?.display_name,
          account_email_address: bootstrap?.email_address,
          account_id: bootstrap?.account_id,
          is_authenticated: !!bootstrap?.signed_in,
        };
        authOverride.current = auth;
        setResolvedConfig((current) => ({
          ...(current ?? config ?? {}),
          ...auth,
        }));
      } catch {
        // Public pages can render without auth bootstrap; this only corrects
        // stale customize state after sign-in/sign-up.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, initialRoute.section]);

  // A changed prop must not briefly expose the previous product while its
  // effect is pending. Keep request readiness independent of auth state.
  const configChanged = customizeState.sourceConfig !== config;
  const currentConfig = configChanged ? config : resolvedConfig;
  const productDependentRoute =
    initialRoute.section === "features" &&
    initialRoute.route.view === "detail" &&
    initialRoute.route.slug === "research-compute";
  const waitingForFeatureConfig =
    productDependentRoute &&
    config === undefined &&
    (configChanged || customizeState.pending);
  const product = currentConfig?.cocalc_product;
  const knownProduct =
    product === "plus" || product === "launchpad" || product === "rocket";

  return (
    <>
      {(!productDependentRoute ||
        (!waitingForFeatureConfig && knownProduct)) && (
        <PublicRouteHeadMetadata config={currentConfig} route={initialRoute} />
      )}
      {waitingForFeatureConfig && (
        <p role="status" aria-live="polite" style={{ padding: 24 }}>
          Loading features…
        </p>
      )}
      <Suspense fallback={null}>
        {!waitingForFeatureConfig && (
          <PublicRouteBody
            config={currentConfig}
            initialRoute={initialRoute}
            redirectToPath={redirectToPath}
          />
        )}
      </Suspense>
    </>
  );
}
