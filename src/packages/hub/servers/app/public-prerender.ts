/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getPublicFeatureIndexPages,
  getPublicFeaturePage,
  PUBLIC_FEATURE_NAV_ITEMS,
  publicFeatureHref,
  type PublicFeaturePage,
  type PublicFeatureSection,
} from "@cocalc/util/public-feature-pages";
import type { PublicMetadataRoute } from "@cocalc/util/public-site-metadata";
import { joinUrlPath } from "@cocalc/util/url-path";

const ARTICLE_STYLE = [
  "box-sizing:border-box",
  "font-family:ui-sans-serif,sans-serif",
  "line-height:1.6",
  "margin:0 auto",
  "max-width:1100px",
  "padding:48px 24px",
].join(";");

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function featurePath(basePath: string, slug?: string): string {
  return joinUrlPath(basePath, slug ? `features/${slug}` : "features");
}

function renderSection(
  section: PublicFeatureSection,
  basePath: string,
): string {
  const paragraphs = (section.paragraphs ?? [])
    .map((paragraph) => `<p>${htmlEscape(paragraph)}</p>`)
    .join("");
  const bullets =
    section.bullets?.length != null && section.bullets.length > 0
      ? `<ul>${section.bullets
          .map((bullet) => `<li>${htmlEscape(bullet)}</li>`)
          .join("")}</ul>`
      : "";
  const links =
    section.links?.length != null && section.links.length > 0
      ? `<ul>${section.links
          .map(
            ({ href, label }) =>
              `<li><a href="${htmlEscape(publicFeatureHref(href, basePath))}">${htmlEscape(label)}</a></li>`,
          )
          .join("")}</ul>`
      : "";
  return `<section><h2>${htmlEscape(
    section.title,
  )}</h2>${paragraphs}${bullets}${links}</section>`;
}

function renderFeatureNavigation(
  basePath: string,
  activeSlug: string | undefined,
  config: { cocalc_product?: string },
): string {
  const links = PUBLIC_FEATURE_NAV_ITEMS.filter(
    ({ slug }) =>
      slug !== activeSlug && getPublicFeaturePage(slug, config) != null,
  )
    .map(
      ({ label, slug }) =>
        `<li><a href="${htmlEscape(featurePath(basePath, slug))}">${htmlEscape(
          label,
        )}</a></li>`,
    )
    .join("");
  return `<nav aria-label="Related CoCalc features"><h2>Explore CoCalc features</h2><ul>${links}</ul></nav>`;
}

function renderFeatureDetail(
  page: PublicFeaturePage,
  basePath: string,
  config: { cocalc_product?: string },
): string {
  const sections = (page.sections ?? [])
    .map((section) => renderSection(section, basePath))
    .join("");
  const title = page.metadataTitle ?? page.title;
  return `<article data-cocalc-public-prerender="feature" style="${ARTICLE_STYLE}">
<header>
  <p>CoCalc feature</p>
  <h1>${htmlEscape(title)}</h1>
  <p>${htmlEscape(page.tagline)}</p>
  <p>${htmlEscape(page.metadataSummary ?? page.summary)}</p>
  <p>${htmlEscape(page.summary)}</p>
</header>
${sections}
${renderFeatureNavigation(basePath, page.slug, config)}
<p><a href="${htmlEscape(
    joinUrlPath(basePath, "auth/sign-up"),
  )}">Start using CoCalc</a></p>
</article>`;
}

function renderFeatureIndex(
  basePath: string,
  config: { cocalc_product?: string },
): string {
  const pages = getPublicFeatureIndexPages(config)
    .map(
      (page) => `<li>
  <h2><a href="${htmlEscape(featurePath(basePath, page.slug))}">${htmlEscape(
    page.metadataTitle ?? page.title,
  )}</a></h2>
  <p>${htmlEscape(page.metadataSummary ?? page.summary)}</p>
</li>`,
    )
    .join("");
  return `<main data-cocalc-public-prerender="feature-index" style="${ARTICLE_STYLE}">
<h1>CoCalc features</h1>
<p>A persistent shared computer for technical work, with notebooks, terminals, documents, software environments, collaboration, and AI agents in one project.</p>
<ul>${pages}</ul>
</main>`;
}

export function renderPublicRoutePrerender(
  route: PublicMetadataRoute,
  basePath: string,
  config?: { cocalc_product?: string },
): string {
  if (route.section !== "features") {
    return "";
  }
  if (route.route?.view === "index") {
    return renderFeatureIndex(basePath, config ?? {});
  }
  if (route.route?.view !== "detail") {
    return "";
  }
  const page = getPublicFeaturePage(route.route.slug, config ?? {});
  return page == null ? "" : renderFeatureDetail(page, basePath, config ?? {});
}
