/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties } from "react";
import { useEffect } from "react";

import { COLORS, SITE_NAME } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getFeatureIndexPages, getFeaturePage } from "./catalog";
import type { PublicFeaturesRoute } from "./routes";
import { featurePath } from "./routes";

interface FeaturesConfig {
  help_email?: string;
  site_name?: string;
}

interface PublicFeaturesAppProps {
  config?: FeaturesConfig;
  initialRoute: PublicFeaturesRoute;
}

const PAGE_STYLE: CSSProperties = {
  minHeight: "100%",
  background: COLORS.GRAY_LLL,
  color: COLORS.GRAY_D,
} as const;

const SHELL_STYLE: CSSProperties = {
  width: "min(1120px, 100%)",
  margin: "0 auto",
  padding: "32px 16px 56px",
} as const;

const HERO_STYLE: CSSProperties = {
  display: "grid",
  gap: "14px",
  borderRadius: "24px",
  background: "white",
  border: `1px solid ${COLORS.GRAY_LL}`,
  boxShadow: "0 20px 40px rgba(0, 0, 0, 0.08)",
  padding: "28px",
} as const;

const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: "16px",
  marginTop: "24px",
} as const;

const CARD_STYLE: CSSProperties = {
  display: "grid",
  gap: "12px",
  borderRadius: "18px",
  background: "white",
  border: `1px solid ${COLORS.GRAY_LL}`,
  padding: "20px",
} as const;

const LINK_STYLE: CSSProperties = {
  color: COLORS.BLUE_D,
  textDecoration: "none",
  fontWeight: 600,
} as const;

const MUTED_STYLE: CSSProperties = {
  color: COLORS.GRAY_M,
} as const;

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function titleForRoute(route: PublicFeaturesRoute, siteName: string): string {
  if (route.view === "detail" && route.slug) {
    return `${getFeaturePage(route.slug)?.title ?? "Features"} – ${siteName}`;
  }
  return `${siteName} features`;
}

function FeaturesIndex({ siteName }: { siteName: string }) {
  const pages = getFeatureIndexPages();
  return (
    <>
      <div style={{ ...MUTED_STYLE, fontSize: "17px", maxWidth: "70ch" }}>
        These pages are the standalone, Next-free public feature overviews for{" "}
        {siteName}. The content is intentionally lightweight now and can be
        modernized further for the coding-agent-focused product direction.
      </div>
      <div style={GRID_STYLE}>
        {pages.map((page) => (
          <div key={page.slug} style={CARD_STYLE}>
            {page.image ? (
              <img
                src={page.image}
                alt={page.title}
                style={{
                  width: "100%",
                  aspectRatio: "16 / 9",
                  objectFit: "cover",
                  borderRadius: "12px",
                  border: `1px solid ${COLORS.GRAY_LL}`,
                  background: COLORS.GRAY_LLL,
                }}
              />
            ) : null}
            <div style={{ ...MUTED_STYLE, fontSize: "13px", fontWeight: 700 }}>
              FEATURE
            </div>
            <h2 style={{ margin: 0, fontSize: "24px" }}>{page.title}</h2>
            <div>{page.summary}</div>
            <div>
              <a href={featurePath(page.slug)} style={LINK_STYLE}>
                Open page
              </a>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function FeatureDetail({
  helpEmail,
  slug,
}: {
  helpEmail?: string;
  slug: string;
}) {
  const page = getFeaturePage(slug);
  if (!page) {
    return (
      <div style={CARD_STYLE}>
        <h2 style={{ margin: 0, fontSize: "24px" }}>Feature page not found</h2>
        <div>
          This route is not currently mapped in the standalone public features
          entry.
        </div>
        <div>
          <a href={featurePath()} style={LINK_STYLE}>
            Back to features
          </a>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "18px" }}>
      <div>
        <a href={featurePath()} style={LINK_STYLE}>
          Back to features
        </a>
      </div>
      <div style={CARD_STYLE}>
        {page.image ? (
          <img
            src={page.image}
            alt={page.title}
            style={{
              width: "100%",
              aspectRatio: "16 / 9",
              objectFit: "cover",
              borderRadius: "14px",
              border: `1px solid ${COLORS.GRAY_LL}`,
              background: COLORS.GRAY_LLL,
            }}
          />
        ) : null}
        <div style={{ ...MUTED_STYLE, fontSize: "13px", fontWeight: 700 }}>
          FEATURE
        </div>
        <h2 style={{ margin: 0, fontSize: "30px" }}>{page.title}</h2>
        <div style={{ fontSize: "18px" }}>{page.tagline}</div>
        <div>{page.summary}</div>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          {page.docsUrl ? (
            <a href={page.docsUrl} style={LINK_STYLE}>
              Documentation
            </a>
          ) : null}
          <a href={appPath("auth/sign-up")} style={LINK_STYLE}>
            Create account
          </a>
          {helpEmail ? (
            <a href={`mailto:${helpEmail}`} style={LINK_STYLE}>
              Contact support
            </a>
          ) : null}
        </div>
      </div>
      {(page.sections ?? []).map((section) => (
        <div key={section.title} style={CARD_STYLE}>
          <h3 style={{ margin: 0, fontSize: "22px" }}>{section.title}</h3>
          {(section.paragraphs ?? []).map((paragraph) => (
            <div key={paragraph}>{paragraph}</div>
          ))}
          {section.bullets?.length ? (
            <ul style={{ margin: 0, paddingLeft: "20px" }}>
              {section.bullets.map((bullet) => (
                <li key={bullet} style={{ marginBottom: "6px" }}>
                  {bullet}
                </li>
              ))}
            </ul>
          ) : null}
          {section.links?.length ? (
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              {section.links.map((link) => (
                <a key={link.href} href={link.href} style={LINK_STYLE}>
                  {link.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default function PublicFeaturesApp({
  config,
  initialRoute,
}: PublicFeaturesAppProps) {
  const siteName = config?.site_name ?? SITE_NAME;
  const title = titleForRoute(initialRoute, siteName);

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <div style={PAGE_STYLE}>
      <div style={SHELL_STYLE}>
        <div style={HERO_STYLE}>
          <div style={{ ...MUTED_STYLE, fontSize: "13px", fontWeight: 700 }}>
            FEATURES
          </div>
          <h1 style={{ margin: 0, fontSize: "38px", lineHeight: 1.1 }}>
            {initialRoute.view === "detail" && initialRoute.slug
              ? (getFeaturePage(initialRoute.slug)?.title ?? "Features")
              : `${siteName} features`}
          </h1>
          <div style={{ ...MUTED_STYLE, fontSize: "17px", maxWidth: "70ch" }}>
            {initialRoute.view === "detail" && initialRoute.slug
              ? getFeaturePage(initialRoute.slug)?.tagline
              : "Standalone feature landing pages served without Next.js."}
          </div>
        </div>
        <div style={{ marginTop: "24px" }}>
          {initialRoute.view === "detail" && initialRoute.slug ? (
            <FeatureDetail
              helpEmail={config?.help_email}
              slug={initialRoute.slug}
            />
          ) : (
            <FeaturesIndex siteName={siteName} />
          )}
        </div>
      </div>
    </div>
  );
}
