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
import {
  getPublicTeamMember,
  PUBLIC_ABOUT_AUDIENCES,
  PUBLIC_ABOUT_HEADLINE,
  PUBLIC_ABOUT_INTRO,
  PUBLIC_ABOUT_MISSION,
  PUBLIC_ABOUT_PRINCIPLES,
  PUBLIC_ABOUT_REASON,
  PUBLIC_TEAM_MEMBERS,
} from "@cocalc/util/public-about-content";
import { getPublicCompareSections } from "@cocalc/util/public-compare-content";
import {
  PUBLIC_FEATURED_GUIDES,
  PUBLIC_GUIDE_GROUPS,
} from "@cocalc/util/public-guides";
import {
  getPublicHomeHighlights,
  PUBLIC_HOME_EYEBROW,
  PUBLIC_HOME_HEADLINE,
  PUBLIC_HOME_INTRO,
  PUBLIC_HOME_SECONDARY_CTA,
  PUBLIC_HOME_TRUST_LINE,
} from "@cocalc/util/public-home-content";
import { getDocsEntry } from "@cocalc/docs";
import {
  PUBLIC_COMMUNITY_INTRO,
  PUBLIC_COMMUNITY_LINKS,
} from "@cocalc/util/public-support-content";
import {
  BILLING_INTERVAL_LABELS,
  hasPriceForBillingInterval,
  membershipPriceDisplay,
  membershipStoreDescription,
  membershipStoreHighlights,
  membershipTiersIncludeAi,
  membershipTrialLabel,
  PUBLIC_PRICING_CUSTOMER_OPERATED,
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
  getPublicRouteMetadata,
  type PublicMetadataRoute,
  type PublicRouteMetadataConfig,
} from "@cocalc/util/public-site-metadata";
import { joinUrlPath } from "@cocalc/util/url-path";

const ARTICLE_STYLE = [
  "box-sizing:border-box",
  "font-family:ui-sans-serif,sans-serif",
  "line-height:1.6",
  "margin:0 auto",
  "max-width:1100px",
  "padding:48px 24px",
].join(";");

const PRODUCT_ROUTES = [
  { href: "cocalc-plus", view: "products-cocalc-plus" },
  { href: "cocalc-star", view: "products-cocalc-star" },
  { href: "cocalc-launchpad", view: "products-cocalc-launchpad" },
  { href: "cocalc-rocket", view: "products-cocalc-rocket" },
] as const;

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
  return `<main data-cocalc-public-prerender="home" style="${ARTICLE_STYLE}">
<header>
  <p>${htmlEscape(PUBLIC_HOME_EYEBROW)}</p>
  <h1>${htmlEscape(PUBLIC_HOME_HEADLINE)}</h1>
  <p>${htmlEscape(PUBLIC_HOME_INTRO)}</p>
  <p>${publicLink(basePath, "auth/sign-up", "Start on CoCalc.ai")} ${publicLink(basePath, PUBLIC_HOME_SECONDARY_CTA.href, PUBLIC_HOME_SECONDARY_CTA.label)}</p>
  <ul>${getPublicHomeHighlights(config)
    .map((highlight) => `<li>${htmlEscape(highlight)}</li>`)
    .join("")}</ul>
  <p>${htmlEscape(PUBLIC_HOME_TRUST_LINE)}</p>
</header>
<section>
  <h2>Agents work where your project lives.</h2>
  <p>Use the integrated Codex agent or Claude Code, or run other command-line agents in project terminals, all with the files, tools, and running services your collaborators already use. Claude Code is an experimental preview on sites that enable it and works with your personal Claude Pro or Max subscription.</p>
  <p>${publicLink(basePath, "features/ai", "See agent workflows")} ${publicLink(basePath, "features/compare", "Compare with agent sandboxes")}</p>
</section>
<section>
  <h2>One project, many workflows.</h2>
  <p>Keep notebooks, terminals, code, documents, services, discussion, history, and recovery in one durable project.</p>
  <p>${publicLink(basePath, "features", "Browse feature workflows")} ${publicLink(basePath, "docs", "Read the documentation")}</p>
</section>
<section>
  <h2>Choose how CoCalc runs.</h2>
  <p>Start with hosted CoCalc.ai, run CoCalc locally or on one VM, or evaluate a customer-operated private deployment.</p>
  <p>${publicLink(basePath, "products", "Review product paths")} ${publicLink(basePath, "pricing", "Pricing and licensing")} ${publicLink(basePath, "support", "Review support and sales")}</p>
</section>
</main>`;
}

function renderProducts(
  route: PublicMetadataRoute,
  basePath: string,
  config: PublicRouteMetadataConfig,
): string {
  const current = getPublicRouteMetadata(route, config, { basePath });
  const isIndex = route.route?.view === "products";
  const productList = isIndex
    ? `<section><h2>Choose who operates it and where it runs</h2><ul><li><h3>${publicLink(
        basePath,
        "pricing",
        "CoCalc.ai",
      )} — Start here</h3><p>Managed hosted projects for individuals and teams that do not want to operate infrastructure.</p></li>${PRODUCT_ROUTES.map(
        ({ href, view }) => {
          const metadata = getPublicRouteMetadata(
            { section: "products", route: { view } },
            config,
            { basePath },
          );
          const title = metadata.title.split(" | ")[0];
          return `<li><h3>${publicLink(
            basePath,
            href ? `products/${href}` : "products",
            title,
          )}</h3><p>${htmlEscape(metadata.description)}</p></li>`;
        },
      ).join("")}</ul></section>`
    : "";
  return `<main data-cocalc-public-prerender="products" style="${ARTICLE_STYLE}">
<header>
  <p>CoCalc product paths</p>
  <h1>${htmlEscape(current.title.split(" | ")[0])}</h1>
  <p>${htmlEscape(current.description)}</p>
</header>
${productList}
<section>
  <h2>One persistent project model</h2>
  <p>Every path uses the same core unit: a persistent Linux project that keeps files, tools, and services together. Collaboration, history, recovery, and agent features vary by product and deployment.</p>
  <p>${publicLink(basePath, "pricing", "Pricing and licensing")} ${publicLink(basePath, "features/compare", "Compare CoCalc fit")} ${publicLink(basePath, "support", "Review support and sales")}</p>
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
    ? "CoCalc Plus is the local, one-user runtime. Use the product paths below when you need hosted collaboration, a shared VM, or a customer-operated private deployment."
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
    "products",
    "Compare customer-operated options",
  );
  const options = isPlusProduct
    ? [
        renderPricingOption(PUBLIC_PRICING_CUSTOMER_OPERATED, compareProducts),
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
        renderPricingOption(PUBLIC_PRICING_CUSTOMER_OPERATED, compareProducts),
      ];
  return `<main data-cocalc-public-prerender="pricing" style="${ARTICLE_STYLE}">
<header>
  <p>CoCalc.ai pricing and licensing</p>
  <h1>Find the right fit</h1>
  <p>${htmlEscape(introduction)}</p>${aiAlert}
  <p>${hostedAction} ${publicLink(basePath, "products", "Compare operating models")}</p>
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
  const bullets =
    section.bullets?.length != null && section.bullets.length > 0
      ? `<ul>${section.bullets
          .map((bullet) => `<li>${htmlEscape(bullet)}</li>`)
          .join("")}</ul>`
      : "";
  const links =
    section.links?.length != null && section.links.length > 0
      ? `<ul>${section.links
          .filter(
            ({ href }) =>
              !href.startsWith("/docs/") ||
              getDocsEntry(href.slice("/docs/".length), {
                product: config.cocalc_product === "plus" ? "plus" : undefined,
              }) != null,
          )
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
  // The Compare page's fit lists depend on the site.
  const sections = (
    page.slug === "compare"
      ? getPublicCompareSections(config)
      : (page.sections ?? [])
  )
    .map((section) => renderSection(section, basePath, config))
    .join("");
  const title = page.metadataTitle ?? page.title;
  const highlights = (page.highlights ?? [])
    .map((item) => `<li>${htmlEscape(item)}</li>`)
    .join("");
  return `<article data-cocalc-public-prerender="feature" style="${ARTICLE_STYLE}">
<header>
  <p>CoCalc feature</p>
  <h1>${htmlEscape(title)}</h1>
  <p>${htmlEscape(page.tagline)}</p>
  <p>${htmlEscape(page.metadataSummary ?? page.summary)}</p>
  <p>${htmlEscape(page.summary)}</p>${highlights ? `<ul>${highlights}</ul>` : ""}
</header>
${sections}
${renderFeatureNavigation(basePath, page.slug, config)}
<p><a href="${htmlEscape(
    joinUrlPath(basePath, "auth/sign-up"),
  )}">${htmlEscape(page.signUpLabel ?? "Start using CoCalc")}</a></p>
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
  return `<main data-cocalc-public-prerender="feature-index" style="${ARTICLE_STYLE}">
<h1>CoCalc features</h1>
<p>Keep people, AI agents, and project work together with notebooks, terminals, documents, software environments, collaboration, and history in persistent Linux projects.</p>
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
  const groups = PUBLIC_GUIDE_GROUPS.map(
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
  ).join("");
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

function renderAboutOverview(basePath: string): string {
  const principles = PUBLIC_ABOUT_PRINCIPLES.map(
    ({ body, title }) =>
      `<li><h3>${htmlEscape(title)}</h3><p>${htmlEscape(body)}</p></li>`,
  ).join("");
  const audiences = PUBLIC_ABOUT_AUDIENCES.map(
    ({ body, title }) =>
      `<li><h3>${htmlEscape(title)}</h3><p>${htmlEscape(body)}</p></li>`,
  ).join("");
  const team = PUBLIC_TEAM_MEMBERS.map(
    ({ name, slug, title }) =>
      `<li>${publicLink(
        basePath,
        `about/team/${slug}`,
        `${name}, ${title}`,
      )}</li>`,
  ).join("");
  return `<main data-cocalc-public-prerender="about" style="${ARTICLE_STYLE}">
<header>
  <p>SageMath, Inc. · The company behind CoCalc</p>
  <h1>${htmlEscape(PUBLIC_ABOUT_HEADLINE)}</h1>
  <p>${htmlEscape(PUBLIC_ABOUT_INTRO)}</p>
</header>
<section>
  <h2>Our mission</h2>
  <p>${htmlEscape(PUBLIC_ABOUT_MISSION)}</p>
  <p>${htmlEscape(PUBLIC_ABOUT_REASON)}</p>
</section>
<section><h2>How we build</h2><ul>${principles}</ul></section>
<section><h2>Who we serve</h2><ul>${audiences}</ul></section>
<section><h2>Meet the team</h2><ul>${team}</ul><p>${publicLink(
    basePath,
    "about/team",
    "Team profiles",
  )} ${publicLink(basePath, "about/events", "Events")}</p></section>
</main>`;
}

function renderAboutTeam(basePath: string): string {
  const members = PUBLIC_TEAM_MEMBERS.map(
    ({ cardText, name, slug, title }) => `<li>
  <h2>${publicLink(basePath, `about/team/${slug}`, `${name}, ${title}`)}</h2>
  <p>${htmlEscape(cardText)}</p>
</li>`,
  ).join("");
  return `<main data-cocalc-public-prerender="about-team" style="${ARTICLE_STYLE}">
<header><p>SageMath, Inc.</p><h1>Meet the people behind CoCalc</h1></header>
<ul>${members}</ul>
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

function renderAbout(route: PublicMetadataRoute, basePath: string): string {
  switch (route.route?.view) {
    case "about":
      return renderAboutOverview(basePath);
    case "about-team":
      return renderAboutTeam(basePath);
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
    return renderAbout(route, basePath);
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
