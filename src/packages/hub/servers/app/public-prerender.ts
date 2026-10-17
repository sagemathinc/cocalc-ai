/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getPublicAiCards,
  getPublicAiHeadline,
  PUBLIC_AI_INTRO,
} from "@cocalc/util/public-ai-page-content";
import {
  getPublicFeatureIndexPages,
  getPublicFeaturePage,
  PUBLIC_FEATURE_NAV_ITEMS,
  publicFeatureHref,
  type PublicFeaturePage,
  type PublicFeatureSection,
} from "@cocalc/util/public-feature-pages";
import {
  getPublicFeaturesIntro,
  getPublicFeaturesSignUp,
  getPublicFeaturesTasks,
  PUBLIC_FEATURES_EYEBROW,
  PUBLIC_FEATURES_HEADLINE,
  PUBLIC_FEATURES_SECONDARY_CTA,
} from "@cocalc/util/public-features-index";
import {
  getPublicAboutIntro,
  getPublicTeamMember,
  PUBLIC_ABOUT_AUDIENCES,
  PUBLIC_ABOUT_HEADLINE,
  PUBLIC_ABOUT_HISTORY,
  PUBLIC_ABOUT_PRINCIPLES,
  PUBLIC_ABOUT_PRINCIPLES_HEADLINE,
  PUBLIC_ABOUT_REASON,
  PUBLIC_ABOUT_TRUST,
  PUBLIC_TEAM_BILLING_CONTACT,
  PUBLIC_TEAM_MEMBERS,
  type PublicAboutTextPart,
} from "@cocalc/util/public-about-content";
import { getPublicCompareSections } from "@cocalc/util/public-compare-content";
import {
  getPublicGuideGroups,
  PUBLIC_FEATURED_GUIDES,
} from "@cocalc/util/public-guides";
import {
  getPublicHomeHighlights,
  isPublicCocalcAiSite,
  PUBLIC_HOME_EYEBROW,
  PUBLIC_HOME_HEADLINE,
  PUBLIC_HOME_INTRO,
  PUBLIC_HOME_SECONDARY_CTA,
} from "@cocalc/util/public-home-content";
import { getDocsEntry } from "@cocalc/docs";
import {
  PUBLIC_COMMUNITY_INTRO,
  PUBLIC_COMMUNITY_LINKS,
} from "@cocalc/util/public-support-content";
import {
  PUBLIC_FOOTER_COMPANY_LINKS,
  PUBLIC_FOOTER_PLATFORM_LINKS,
  PUBLIC_FOOTER_RESOURCES_LINKS,
  type PublicFooterLink,
} from "@cocalc/util/public-footer-links";
import {
  BILLING_INTERVAL_LABELS,
  getPublicPricingCustomerOperated,
  hasPriceForBillingInterval,
  membershipPriceDisplay,
  membershipStoreDescription,
  membershipStoreHighlights,
  membershipTiersIncludeAi,
  membershipTrialLabel,
  PUBLIC_PRICING_INCLUDED_AI_ALERT,
  PUBLIC_PRICING_NO_TIERS,
  PUBLIC_PRICING_ORGANIZATION_LICENSING,
  PUBLIC_PRICING_PLUS_TEAMS_TITLE,
  PUBLIC_PRICING_PRODUCT_QUOTES,
  PUBLIC_PRICING_PROJECT_HOSTS,
  PUBLIC_PRICING_TEAM_SEATS,
  PUBLIC_PRICING_TEAMS_TITLE,
  publicStoreMembershipTiers,
  type PublicPricingTier,
} from "@cocalc/util/public-pricing";
import {
  getShownPublicProductByView,
  type PublicProduct,
} from "@cocalc/util/public-product-availability";
import {
  getPublicPlusPricingIntro,
  getPublicProductPageCopy,
  getPublicWhereToRunActions,
  getPublicWhereToRunComparison,
  getPublicWhereToRunHeadline,
  getPublicWhereToRunIntro,
  getPublicWhereToRunPaths,
  publicProductTextParts,
  PUBLIC_PRODUCT_SHARED_NOTE,
  PUBLIC_PRODUCTS_PAGE_LINK,
  PUBLIC_WHERE_TO_RUN_COMPARISON_LINKS,
  PUBLIC_WHERE_TO_RUN_CONTACT,
  PUBLIC_WHERE_TO_RUN_PATHS_TITLE,
  PUBLIC_WHERE_TO_RUN_TITLE,
  PUBLIC_WHERE_TO_RUN_WORKFLOW,
  type PublicProductBlock,
  type PublicProductLink,
} from "@cocalc/util/public-products-content";
import {
  getPublicRouteMetadata,
  type PublicMetadataRoute,
  type PublicRouteMetadataConfig,
} from "@cocalc/util/public-site-metadata";
import {
  COCALC_AI_SIGN_UP_LABEL,
  getPublicFeatureSignUpLabel,
  isCocalcAiLaunchpad,
  PUBLIC_SIGN_UP_LABEL,
} from "@cocalc/util/public-site-policy";
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

function publicPath(basePath: string, path: string): string {
  return joinUrlPath(basePath, path);
}

function publicLink(basePath: string, path: string, label: string): string {
  return `<a href="${htmlEscape(publicPath(basePath, path))}">${htmlEscape(
    label,
  )}</a>`;
}

function publicOrExternalLink(
  basePath: string,
  href: string,
  label: string,
): string {
  const external = /^https?:\/\//.test(href);
  const resolved = external ? href : publicPath(basePath, href);
  const externalAttributes = external
    ? ' rel="noreferrer" target="_blank"'
    : "";
  return `<a href="${htmlEscape(resolved)}"${externalAttributes}>${htmlEscape(
    label,
  )}</a>`;
}

function renderHome(
  basePath: string,
  config: PublicRouteMetadataConfig,
): string {
  const signUpLabel = isCocalcAiLaunchpad(config)
    ? COCALC_AI_SIGN_UP_LABEL
    : PUBLIC_SIGN_UP_LABEL;
  return `<main data-cocalc-public-prerender="home" style="${ARTICLE_STYLE}">
<header>
  <p>${htmlEscape(PUBLIC_HOME_EYEBROW)}</p>
  <h1>${htmlEscape(PUBLIC_HOME_HEADLINE)}</h1>
  <p>${htmlEscape(PUBLIC_HOME_INTRO)}</p>
  <p>${publicLink(basePath, "auth/sign-up", signUpLabel)} ${publicLink(basePath, PUBLIC_HOME_SECONDARY_CTA.href, PUBLIC_HOME_SECONDARY_CTA.label)}</p>
  <ul>${getPublicHomeHighlights(config)
    .map((highlight) => `<li>${htmlEscape(highlight)}</li>`)
    .join("")}</ul>
</header>
<section>
  <h2>Agents work where your project lives.</h2>
  <p>Use the integrated Codex agent or Claude Code, or run other command-line agents in project terminals, all with the files, tools, and running services your collaborators already use. Claude Code is an experimental preview on sites that enable it and works with your personal Claude Pro or Max subscription.</p>
  <p>${publicLink(basePath, "features/ai", "See agent workflows")} ${publicLink(basePath, "features/compare", "Compare with agent sandboxes")}</p>
</section>
</main>`;
}

// A product page link: a path relative to the site's base path, a fragment on
// the same page, or an absolute URL.
function productLinks(
  basePath: string,
  links: readonly PublicProductLink[],
): string {
  return links
    .map(({ href, label }) => {
      const resolved =
        href.startsWith("#") || /^https?:\/\//.test(href)
          ? href
          : publicPath(basePath, href);
      return `<a href="${htmlEscape(resolved)}">${htmlEscape(label)}</a>`;
    })
    .join(" ");
}

function paragraphs(texts: readonly string[]): string {
  return texts.map((text) => `<p>${htmlEscape(text)}</p>`).join("");
}

// One block of a product page card, as its React page renders it: a
// paragraph with its code and links, a caveat, or a command.
function productBlock(basePath: string, block: PublicProductBlock): string {
  if (typeof block === "string" || "text" in block) {
    return `<p>${publicProductTextParts(block)
      .map((part) =>
        "code" in part
          ? `<code>${htmlEscape(part.code)}</code>`
          : "link" in part
            ? productLinks(basePath, [part.link])
            : htmlEscape(part.text),
      )
      .join("")}</p>`;
  }
  if ("note" in block) return `<p>${htmlEscape(block.note)}</p>`;
  return `<pre><code>${htmlEscape(block.code)}</code></pre>`;
}

// A product page, from the words its React page renders, in its order: the
// lead, the shared note, the positioning cards and the page's cards.
function renderProductPage(
  product: PublicProduct,
  description: string,
  basePath: string,
): string {
  const copy = getPublicProductPageCopy(product.id);
  const points = copy.points
    .map(
      ({ body, title }) =>
        `<li><h3>${htmlEscape(title)}</h3><p>${htmlEscape(body)}</p></li>`,
    )
    .join("");
  const sections = copy.sections
    .map(
      ({ blocks, key, links = [], title }) =>
        `<section${
          key === "install" ? ` id="install-${htmlEscape(product.slug)}"` : ""
        }><h2>${htmlEscape(title)}</h2>${blocks
          .map((block) => productBlock(basePath, block))
          .join("")}${
          links.length > 0 ? `<p>${productLinks(basePath, links)}</p>` : ""
        }</section>`,
    )
    .join("\n");
  const notes =
    copy.notes.length > 0
      ? `<section><h2>${htmlEscape(copy.notesTitle)}</h2><ul>${copy.notes
          .map((note) => `<li>${htmlEscape(note)}</li>`)
          .join("")}</ul></section>`
      : "";
  const links =
    copy.links.length > 0 ? `<p>${productLinks(basePath, copy.links)}</p>` : "";
  // The header prints the route's description unless the lead already says
  // it, as a feature page prints each lead line once.
  const descriptionLine = copy.lead.paragraphs.some((paragraph) =>
    paragraph.includes(description),
  )
    ? ""
    : `\n  <p>${htmlEscape(description)}</p>`;
  return `<main data-cocalc-public-prerender="products" style="${ARTICLE_STYLE}">
<header>
  <p>${htmlEscape(PUBLIC_WHERE_TO_RUN_TITLE)}</p>
  <h1>${htmlEscape(product.name)}</h1>${descriptionLine}
</header>
<section>
  <h2>${htmlEscape(copy.lead.title)}</h2>
  ${paragraphs(copy.lead.paragraphs)}
  <p>${productLinks(basePath, copy.lead.actions)}</p>
</section>
<p><strong>${htmlEscape(PUBLIC_PRODUCT_SHARED_NOTE.title)}</strong> ${htmlEscape(
    PUBLIC_PRODUCT_SHARED_NOTE.body,
  )}</p>
<ul>${points}</ul>
${sections}
${notes}
${links}
</main>`;
}

function renderProducts(
  route: PublicMetadataRoute,
  basePath: string,
  config: PublicRouteMetadataConfig,
): string {
  const current = getPublicRouteMetadata(route, config, { basePath });
  // A hidden product's page redirects to the products page, so it renders
  // that page.
  const product = getShownPublicProductByView(route.route?.view);
  if (product != null) {
    return renderProductPage(product, current.description, basePath);
  }
  const paths = getPublicWhereToRunPaths()
    .map(
      ({ detail, href, title }) =>
        `<li><h3>${productLinks(basePath, [{ href, label: title }])}</h3><p>${htmlEscape(
          detail,
        )}</p></li>`,
    )
    .join("");
  const comparison = getPublicWhereToRunComparison();
  const table =
    comparison == null
      ? ""
      : `<section>
  <h2>${htmlEscape(comparison.title)}</h2>
  <table>
  <caption>${htmlEscape(comparison.caption)}</caption>
  <thead><tr><td></td><th scope="col">CoCalc.ai</th><th scope="col">CoCalc Star</th></tr></thead>
  <tbody>${comparison.rows
    .map(
      ({ cocalcAi, label, star }) =>
        `<tr><th scope="row">${htmlEscape(label)}</th><td>${htmlEscape(
          cocalcAi,
        )}</td><td>${htmlEscape(star)}</td></tr>`,
    )
    .join("")}</tbody>
  </table>
  <p>${productLinks(basePath, PUBLIC_WHERE_TO_RUN_COMPARISON_LINKS)}</p>
</section>`;
  // As on the React page, without the compute card where the Research
  // Compute page is not shown.
  const workflow = PUBLIC_WHERE_TO_RUN_WORKFLOW.cards
    .filter(
      ({ href }) =>
        href !== "features/research-compute" ||
        getPublicFeaturePage("research-compute", config) != null,
    )
    .map(
      ({ body, href, label, title }) =>
        `<li><h3>${htmlEscape(title)}</h3><p>${htmlEscape(body)}</p><p>${publicLink(
          basePath,
          href,
          label,
        )}</p></li>`,
    )
    .join("");
  return `<main data-cocalc-public-prerender="products" style="${ARTICLE_STYLE}">
<header>
  <h1>${htmlEscape(current.title.split(" | ")[0])}</h1>
  <h2>${htmlEscape(getPublicWhereToRunHeadline())}</h2>
  <p>${htmlEscape(getPublicWhereToRunIntro())}</p>
  <p>${productLinks(basePath, getPublicWhereToRunActions())}</p>
</header>
<section>
  <h2>${htmlEscape(PUBLIC_WHERE_TO_RUN_PATHS_TITLE)}</h2>
  <ul>${paths}</ul>
</section>
${table}
<section>
  <h2>${htmlEscape(PUBLIC_WHERE_TO_RUN_WORKFLOW.title)}</h2>
  <p>${htmlEscape(PUBLIC_WHERE_TO_RUN_WORKFLOW.body)}</p>
  <ul>${workflow}</ul>
</section>
<section>
  <h2>${htmlEscape(PUBLIC_WHERE_TO_RUN_CONTACT.title)}</h2>
  <p>${htmlEscape(PUBLIC_WHERE_TO_RUN_CONTACT.body)}</p>
  <p>${productLinks(basePath, PUBLIC_WHERE_TO_RUN_CONTACT.links)}</p>
</section>
</main>`;
}

// Data the shell loads before rendering; a route renders without it when it
// is missing.
export interface PublicRoutePrerenderData {
  // Membership tiers from the tier API's source. Only store-visible tiers are
  // rendered.
  pricingTiers?: readonly PublicPricingTier[];
}

// One tier as the pricing page's tier card shows it, with both billing
// intervals, since the fallback has no interval switch.
function renderPricingTier(tier: PublicPricingTier): string {
  const trial = membershipTrialLabel(tier);
  const prices = (["year", "month"] as const)
    .map((interval) => {
      const price = hasPriceForBillingInterval(tier, interval)
        ? membershipPriceDisplay(tier, interval)
        : undefined;
      if (price == null) return "";
      const text = [`${price.amount} ${price.suffix}`, price.billingLine]
        .filter(Boolean)
        .join(" · ");
      return `<p>${BILLING_INTERVAL_LABELS[interval]}: ${htmlEscape(text)}</p>`;
    })
    .join("");
  const description = membershipStoreDescription(tier);
  const highlights = membershipStoreHighlights(tier);
  return `<li><h3>${htmlEscape(tier.label ?? tier.id)}</h3>${
    trial ? `<p>${htmlEscape(trial)}</p>` : ""
  }${prices}${description ? `<p>${htmlEscape(description)}</p>` : ""}${
    highlights.length > 0
      ? `<ul>${highlights
          .map((highlight) => `<li>${htmlEscape(highlight)}</li>`)
          .join("")}</ul>`
      : ""
  }</li>`;
}

function renderPricingOption(
  { body, title }: { body: string; title: string },
  action = "",
): string {
  return `<li><h3>${htmlEscape(title)}</h3><p>${htmlEscape(body)}</p>${
    action ? `<p>${action}</p>` : ""
  }</li>`;
}

function renderPricing(
  basePath: string,
  config: PublicRouteMetadataConfig,
  pricingTiers?: readonly PublicPricingTier[],
): string {
  const isPlusProduct = config.cocalc_product === "plus";
  const tiers =
    isPlusProduct || pricingTiers == null
      ? undefined
      : publicStoreMembershipTiers(pricingTiers);
  const introduction = isPlusProduct
    ? getPublicPlusPricingIntro()
    : "The membership options on this page apply to the hosted service on this site. For local, single-VM, and customer-operated paths, continue through the relevant product or contact page.";
  const aiAlert =
    tiers != null && membershipTiersIncludeAi(tiers)
      ? `\n  <p>${htmlEscape(PUBLIC_PRICING_INCLUDED_AI_ALERT)}</p>`
      : "";
  const hostedAction = isPlusProduct
    ? ""
    : publicLink(basePath, "auth/sign-up", "Create account for hosted CoCalc");
  const tierList =
    tiers == null
      ? ""
      : tiers.length > 0
        ? `\n  <ul>${tiers.map(renderPricingTier).join("")}</ul>`
        : `\n  <p>${htmlEscape(PUBLIC_PRICING_NO_TIERS)}</p>`;
  const hostedSection = isPlusProduct
    ? ""
    : `<section>
  <h2>Hosted memberships</h2>
  <p>Use CoCalc.ai without operating CoCalc yourself.${
    tiers == null
      ? " Current membership tiers, limits, and billing choices appear on this page when it loads."
      : ""
  }</p>${tierList}
</section>`;
  const compareProducts = publicLink(
    basePath,
    PUBLIC_PRODUCTS_PAGE_LINK.href,
    PUBLIC_PRODUCTS_PAGE_LINK.label,
  );
  const options = isPlusProduct
    ? [
        renderPricingOption(
          getPublicPricingCustomerOperated(),
          compareProducts,
        ),
        renderPricingOption(PUBLIC_PRICING_PRODUCT_QUOTES),
      ]
    : [
        renderPricingOption(
          PUBLIC_PRICING_TEAM_SEATS,
          publicLink(basePath, "auth/sign-up", "Create account for team seats"),
        ),
        renderPricingOption(PUBLIC_PRICING_ORGANIZATION_LICENSING),
        ...(getPublicFeaturePage("research-compute", config) != null
          ? [
              renderPricingOption(
                PUBLIC_PRICING_PROJECT_HOSTS,
                publicLink(
                  basePath,
                  "features/research-compute",
                  "Evaluate research compute",
                ),
              ),
            ]
          : []),
        renderPricingOption(
          getPublicPricingCustomerOperated(),
          compareProducts,
        ),
      ];
  return `<main data-cocalc-public-prerender="pricing" style="${ARTICLE_STYLE}">
<header>
  <p>CoCalc.ai pricing and licensing</p>
  <h1>Find the right fit</h1>
  <p>${htmlEscape(introduction)}</p>${aiAlert}
  <p>${hostedAction} ${publicLink(basePath, PUBLIC_PRODUCTS_PAGE_LINK.href, PUBLIC_PRODUCTS_PAGE_LINK.label)}</p>
</header>
${hostedSection}
<section>
  <h2>${htmlEscape(isPlusProduct ? PUBLIC_PRICING_PLUS_TEAMS_TITLE : PUBLIC_PRICING_TEAMS_TITLE)}</h2>
  <ul>${options.join("")}</ul>
  <p>${publicLink(basePath, "support", "Pricing and licensing support options")}</p>
</section>
</main>`;
}

function renderSection(
  section: PublicFeatureSection,
  basePath: string,
  config: PublicRouteMetadataConfig,
): string {
  const paragraphs = (section.paragraphs ?? [])
    .map((paragraph) => `<p>${htmlEscape(paragraph)}</p>`)
    .join("");
  const cards = (section.cards ?? [])
    .map(
      ({ body, link, title }) =>
        `<h3>${htmlEscape(title)}</h3><p>${htmlEscape(body)}</p>${
          link && featureLinkVisible(link.href, config)
            ? `<p>${featureLink(link, basePath)}</p>`
            : ""
        }`,
    )
    .join("");
  const bulletList =
    section.bullets?.length != null && section.bullets.length > 0
      ? `<ul>${section.bullets
          .map((bullet) => `<li>${htmlEscape(bullet)}</li>`)
          .join("")}</ul>`
      : "";
  // Collapsed on the page too, so crawlers and visitors get the same text.
  const bullets =
    bulletList && section.detailsLabel
      ? `<details><summary>${htmlEscape(
          section.detailsLabel,
        )}</summary>${bulletList}</details>`
      : bulletList;
  const links =
    section.links?.length != null && section.links.length > 0
      ? `<ul>${section.links
          .filter(({ href }) => featureLinkVisible(href, config))
          .map((link) => `<li>${featureLink(link, basePath)}</li>`)
          .join("")}</ul>`
      : "";
  return `<section><h2>${htmlEscape(
    section.title,
  )}</h2>${paragraphs}${cards}${bullets}${links}</section>`;
}

// Documentation links are shown only where the documentation exists.
function featureLinkVisible(
  href: string,
  config: PublicRouteMetadataConfig,
): boolean {
  return (
    !href.startsWith("/docs/") ||
    getDocsEntry(href.slice("/docs/".length), {
      product: config.cocalc_product === "plus" ? "plus" : undefined,
    }) != null
  );
}

function featureLink(
  { href, label }: { href: string; label: string },
  basePath: string,
): string {
  return `<a href="${htmlEscape(publicFeatureHref(href, basePath))}">${htmlEscape(label)}</a>`;
}

function renderFeatureNavigation(
  basePath: string,
  activeSlug: string | undefined,
  config: PublicRouteMetadataConfig,
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
  config: PublicRouteMetadataConfig,
): string {
  // The Compare page's fit lists depend on the site. The AI page's hero shows
  // its headline for this site and its intro, and its sections are the page's
  // agent cards, as on the React page.
  const isAiPage = page.slug === "ai";
  const sections = (
    (page.slug === "compare"
      ? getPublicCompareSections(config)
      : isAiPage
        ? getPublicAiCards(config)
        : page.sections) ?? []
  )
    .map((section) => renderSection(section, basePath, config))
    .join("");
  const title = page.metadataTitle ?? page.title;
  const highlights = (page.highlights ?? [])
    .map((item) => `<li>${htmlEscape(item)}</li>`)
    .join("");
  const lead = isAiPage
    ? [getPublicAiHeadline(config), PUBLIC_AI_INTRO]
    : [page.tagline, page.metadataSummary ?? page.summary, page.summary];
  return `<article data-cocalc-public-prerender="feature" style="${ARTICLE_STYLE}">
<header>
  <p>CoCalc feature</p>
  <h1>${htmlEscape(title)}</h1>
${lead.map((line) => `  <p>${htmlEscape(line)}</p>`).join("\n")}${
    highlights ? `<ul>${highlights}</ul>` : ""
  }
</header>
${sections}
${renderFeatureNavigation(basePath, page.slug, config)}
<p><a href="${htmlEscape(joinUrlPath(basePath, "auth/sign-up"))}">${htmlEscape(
    getPublicFeatureSignUpLabel(page, isCocalcAiLaunchpad(config)),
  )}</a></p>
</article>`;
}

function renderFeatureIndex(
  basePath: string,
  config: PublicRouteMetadataConfig,
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
  const link = ({ href, label }: { href: string; label: string }) =>
    `<a href="${htmlEscape(publicFeatureHref(href, basePath))}">${htmlEscape(label)}</a>`;
  const signUp = getPublicFeaturesSignUp(config);
  const actions = [...(signUp ? [signUp] : []), PUBLIC_FEATURES_SECONDARY_CTA]
    .map(link)
    .join(" ");
  // Text between backticks is a command name, as on the React page.
  const tasks = getPublicFeaturesTasks(config)
    .map(
      ({ body, href, title }) =>
        `<li><h2>${link({ href, label: title })}</h2><p>${body
          .split("`")
          .map((part, index) =>
            index % 2 ? `<code>${htmlEscape(part)}</code>` : htmlEscape(part),
          )
          .join("")}</p></li>`,
    )
    .join("");
  return `<main data-cocalc-public-prerender="feature-index" style="${ARTICLE_STYLE}">
<header>
  <p>${htmlEscape(PUBLIC_FEATURES_EYEBROW)}</p>
  <h1>${htmlEscape(PUBLIC_FEATURES_HEADLINE)}</h1>
  <p>${htmlEscape(getPublicFeaturesIntro(config))}</p>
  <p>${actions}</p>
</header>
<ul>${tasks}</ul>
<ul>${pages}</ul>
</main>`;
}

function guideVisible(
  href: string,
  config: PublicRouteMetadataConfig,
): boolean {
  if (!href.startsWith("/docs/")) return true;
  return (
    getDocsEntry(href, {
      product: config.cocalc_product === "plus" ? "plus" : undefined,
    }) != null
  );
}

function renderGuides(
  basePath: string,
  config: PublicRouteMetadataConfig,
): string {
  const featured = PUBLIC_FEATURED_GUIDES.filter(({ href }) =>
    guideVisible(href, config),
  )
    .map(
      ({ body, href, title }) =>
        `<li><h2>${publicOrExternalLink(
          basePath,
          href,
          title,
        )}</h2><p>${htmlEscape(body)}</p></li>`,
    )
    .join("");
  const groups = getPublicGuideGroups()
    .map(
      ({ guides, intro, title }) => `<section>
  <h2>${htmlEscape(title)}</h2>
  <p>${htmlEscape(intro)}</p>
  <ul>${guides
    .filter(({ href }) => guideVisible(href, config))
    .map(
      ({ body, href, title }) =>
        `<li><h3>${publicOrExternalLink(
          basePath,
          href,
          title,
        )}</h3><p>${htmlEscape(body)}</p></li>`,
    )
    .join("")}</ul>
</section>`,
    )
    .join("");
  return `<main data-cocalc-public-prerender="guides" style="${ARTICLE_STYLE}">
<header>
  <p>CoCalc workflow guides</p>
  <h1>Guides</h1>
  <p>Plan setup, notebooks, terminals, code review, and deployment paths around durable CoCalc projects.</p>
  <p>${publicLink(basePath, "docs", "Browse CoCalc documentation")}</p>
</header>
<section>
  <h2>Featured workflows</h2>
  <ul>${featured}</ul>
</section>
${groups}
</main>`;
}

// Shared About text, as the React page renders it: links resolve against the
// site's base path.
function renderAboutText(
  basePath: string,
  parts: readonly PublicAboutTextPart[],
): string {
  return parts
    .map(({ path, text }) =>
      path == null ? htmlEscape(text) : publicLink(basePath, path, text),
    )
    .join("");
}

function renderAboutOverview(
  basePath: string,
  config: PublicRouteMetadataConfig,
): string {
  const principles = PUBLIC_ABOUT_PRINCIPLES.map(
    ({ body, title }) =>
      `<li><h3>${htmlEscape(title)}</h3><p>${htmlEscape(body)}</p></li>`,
  ).join("");
  // As on the React page, a fact with a path links its value and detail.
  const facts = PUBLIC_ABOUT_TRUST.facts
    .map(({ detail, path, value }) => {
      const content = `<strong>${htmlEscape(value)}</strong> ${htmlEscape(
        detail,
      )}`;
      return `<li>${
        path == null
          ? content
          : `<a href="${htmlEscape(publicPath(basePath, path))}">${content}</a>`
      }</li>`;
    })
    .join("");
  const { link, note } = PUBLIC_ABOUT_TRUST;
  const audiences = PUBLIC_ABOUT_AUDIENCES.map(
    ({ body, title }) =>
      `<li><h3>${htmlEscape(title)}</h3><p>${htmlEscape(body)}</p></li>`,
  ).join("");
  const timeline = PUBLIC_ABOUT_HISTORY.timeline
    .map(
      ({ body, year }) =>
        `<li><strong>${htmlEscape(year)}</strong> ${htmlEscape(body)}</li>`,
    )
    .join("");
  const team = PUBLIC_TEAM_MEMBERS.map(
    ({ name, slug, title }) =>
      `<li>${publicLink(
        basePath,
        `about/team/${slug}`,
        `${name}, ${title}`,
      )}</li>`,
  ).join("");
  // The React page ends with PublicNextStep, the shared call to action that
  // no crawler fallback renders, so its heading is not repeated here.
  return `<main data-cocalc-public-prerender="about" style="${ARTICLE_STYLE}">
<header>
  <p>SageMath, Inc. · The company behind CoCalc</p>
  <h1>${htmlEscape(PUBLIC_ABOUT_HEADLINE)}</h1>
  <p>${renderAboutText(
    basePath,
    getPublicAboutIntro(isPublicCocalcAiSite(config)),
  )}</p>
</header>
<section>
  <p>How we build</p>
  <h2>${htmlEscape(PUBLIC_ABOUT_PRINCIPLES_HEADLINE)}</h2>
  <p>${htmlEscape(PUBLIC_ABOUT_REASON)}</p>
  <ul>${principles}</ul>
</section>
<section>
  <p>${htmlEscape(PUBLIC_ABOUT_TRUST.eyebrow)}</p>
  <h2>${htmlEscape(PUBLIC_ABOUT_TRUST.headline)}</h2>
  <p>${htmlEscape(PUBLIC_ABOUT_TRUST.intro)}</p>
  <ul>${facts}</ul>
  <p><strong>${htmlEscape(note.title)}</strong> ${htmlEscape(note.body)}</p>
  <p>${publicLink(basePath, link.path, link.label)}</p>
</section>
<section><h2>Who we serve</h2><ul>${audiences}</ul></section>
<section>
  <p>${htmlEscape(PUBLIC_ABOUT_HISTORY.eyebrow)}</p>
  <h2>${htmlEscape(PUBLIC_ABOUT_HISTORY.headline)}</h2>
  <ul>${timeline}</ul>
</section>
<section><h2>Meet the team</h2><ul>${team}</ul><p>${publicLink(
    basePath,
    "about/team",
    "Team profiles",
  )} ${publicLink(basePath, "about/events", "Events")}</p></section>
</main>`;
}

function renderAboutTeam(
  basePath: string,
  config: PublicRouteMetadataConfig,
): string {
  const members = PUBLIC_TEAM_MEMBERS.map(
    ({ cardText, name, slug, title }) => `<li>
  <h2>${publicLink(basePath, `about/team/${slug}`, `${name}, ${title}`)}</h2>
  <p>${htmlEscape(cardText)}</p>
</li>`,
  ).join("");
  const { label, path, text, url } = PUBLIC_TEAM_BILLING_CONTACT;
  const billingHref = isPublicCocalcAiSite(config)
    ? publicPath(basePath, path)
    : url;
  return `<main data-cocalc-public-prerender="about-team" style="${ARTICLE_STYLE}">
<header><p>SageMath, Inc.</p><h1>Meet the people behind CoCalc</h1></header>
<ul>${members}</ul>
<p>${htmlEscape(text)} <a href="${htmlEscape(billingHref)}">${htmlEscape(
    label,
  )}</a>.</p>
<p>${publicLink(basePath, "about", "About CoCalc")}</p>
</main>`;
}

function renderAboutTeamMember(basePath: string, slug?: string): string {
  const member = getPublicTeamMember(slug);
  if (member == null) return "";
  return `<main data-cocalc-public-prerender="about-team-member" style="${ARTICLE_STYLE}">
<header>
  <p>SageMath, Inc. team</p>
  <h1>${htmlEscape(member.name)}</h1>
  <p>${htmlEscape(member.title)}</p>
</header>
<p>${htmlEscape(member.cardText)}</p>
<p>${publicLink(basePath, "about/team", "Meet the full team")}</p>
</main>`;
}

function renderAbout(
  route: PublicMetadataRoute,
  basePath: string,
  config: PublicRouteMetadataConfig,
): string {
  switch (route.route?.view) {
    case "about":
      return renderAboutOverview(basePath, config);
    case "about-team":
      return renderAboutTeam(basePath, config);
    case "about-team-member":
      return renderAboutTeamMember(basePath, route.route.teamSlug);
    // Events are database-backed. Do not render a static list that could
    // disagree with the current event records loaded by the application.
    case "about-events":
    default:
      return "";
  }
}

function renderSupport(route: PublicMetadataRoute, basePath: string): string {
  if (route.route?.view === "community") {
    const links = PUBLIC_COMMUNITY_LINKS.map(
      ({ description, href, title }) => `<li>
  <h2>${publicOrExternalLink(basePath, href, title)}</h2>
  <p>${htmlEscape(description)}</p>
</li>`,
    ).join("");
    return `<main data-cocalc-public-prerender="support-community" style="${ARTICLE_STYLE}">
<header><p>CoCalc support</p><h1>Community support</h1><p>${htmlEscape(
      PUBLIC_COMMUNITY_INTRO,
    )}</p></header>
<ul>${links}</ul>
<p>${publicLink(basePath, "support", "Direct support options")} ${publicLink(
      basePath,
      "docs",
      "Documentation",
    )}</p>
</main>`;
  }
  if (route.route?.view !== "index") return "";
  return `<main data-cocalc-public-prerender="support" style="${ARTICLE_STYLE}">
<header>
  <p>CoCalc help and evaluation</p>
  <h1>Support</h1>
  <p>Get help choosing a product path, discussing pricing or deployment, or resolving an account or project issue.</p>
</header>
<section>
  <h2>Find the right next step</h2>
  <ul>
    <li><h3>${publicLink(
      basePath,
      "docs",
      "Documentation",
    )}</h3><p>Use task-focused product and workflow documentation.</p></li>
    <li><h3>${publicLink(
      basePath,
      "support/community",
      "Community channels",
    )}</h3><p>Inspect the source, follow public updates, and join public discussions.</p></li>
    <li><h3>${publicLink(
      basePath,
      "pricing",
      "Pricing and licensing",
    )}</h3><p>Review hosted memberships and paths for teams and organizations.</p></li>
  </ul>
</section>
<p>Direct contact and ticket options appear on this page according to the current deployment configuration.</p>
</main>`;
}

// Each list shows its column title, as in the React footer, as bold text
// rather than a heading, so the page's heading outline does not change.
function renderFooterNav(
  basePath: string,
  title: string,
  links: readonly PublicFooterLink[],
): string {
  return `<nav aria-label="${htmlEscape(
    `${title} footer links`,
  )}"><p><strong>${htmlEscape(title)}</strong></p><ul>${links
    .map(({ label, path }) => `<li>${publicLink(basePath, path, label)}</li>`)
    .join("")}</ul></nav>`;
}

// The fixed page links of the React footer, for crawlers and visitors
// without JavaScript. The shell adds this after a page's crawler content; the
// public bundle replaces both when it starts, so it never shows beside the
// React footer.
export function renderPublicFooterPrerender(basePath: string): string {
  return `<footer data-cocalc-public-prerender="footer" style="${ARTICLE_STYLE}">
${renderFooterNav(basePath, "Platform", PUBLIC_FOOTER_PLATFORM_LINKS)}
${renderFooterNav(basePath, "Resources", PUBLIC_FOOTER_RESOURCES_LINKS)}
${renderFooterNav(basePath, "Company", PUBLIC_FOOTER_COMPANY_LINKS)}
</footer>`;
}

export function renderPublicRoutePrerender(
  route: PublicMetadataRoute,
  basePath: string,
  config?: PublicRouteMetadataConfig,
  data: PublicRoutePrerenderData = {},
): string {
  const resolvedConfig = config ?? {};
  if (route.section === "home") {
    return renderHome(basePath, resolvedConfig);
  }
  if (route.section === "products") {
    return renderProducts(route, basePath, resolvedConfig);
  }
  if (route.section === "pricing") {
    return renderPricing(basePath, resolvedConfig, data.pricingTiers);
  }
  if (route.section === "guides") {
    return renderGuides(basePath, resolvedConfig);
  }
  if (route.section === "about") {
    return renderAbout(route, basePath, resolvedConfig);
  }
  if (route.section === "support") {
    return renderSupport(route, basePath);
  }
  if (route.section !== "features") {
    return "";
  }
  if (route.route?.view === "index") {
    return renderFeatureIndex(basePath, resolvedConfig);
  }
  if (route.route?.view !== "detail") {
    return "";
  }
  const page = getPublicFeaturePage(route.route.slug, resolvedConfig);
  return page == null
    ? ""
    : renderFeatureDetail(page, basePath, resolvedConfig);
}
