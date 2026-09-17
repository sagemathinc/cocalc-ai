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
import {
  PUBLIC_FEATURED_GUIDES,
  PUBLIC_GUIDE_GROUPS,
} from "@cocalc/util/public-guides";
import { getDocsEntry } from "@cocalc/docs";
import {
  PUBLIC_COMMUNITY_INTRO,
  PUBLIC_COMMUNITY_LINKS,
} from "@cocalc/util/public-support-content";
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

function renderHome(basePath: string): string {
  return `<main data-cocalc-public-prerender="home" style="${ARTICLE_STYLE}">
<header>
  <p>Persistent shared projects</p>
  <h1>Keep people, AI agents, and project work together.</h1>
  <p>Files, notebooks, terminals, services, and history stay in a shared Linux project so work can continue, be reviewed, and be handed off.</p>
  <p>${publicLink(basePath, "auth/sign-up", "Start on CoCalc.ai")} ${publicLink(basePath, "products", "Ways to run CoCalc")}</p>
</header>
<section>
  <h2>Agents work where your project lives.</h2>
  <p>Use integrated Codex, or run Claude Code and other shell-based agents in project terminals, with the files, tools, and running services your collaborators already use.</p>
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
  <p>${publicLink(basePath, "products", "Review product paths")} ${publicLink(basePath, "pricing", "Pricing and licensing")} ${publicLink(basePath, "support", "Talk with CoCalc")}</p>
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
  <p>${publicLink(basePath, "pricing", "Pricing and licensing")} ${publicLink(basePath, "features/compare", "Compare CoCalc fit")} ${publicLink(basePath, "support", "Talk with CoCalc")}</p>
</section>
</main>`;
}

function renderPricing(basePath: string): string {
  return `<main data-cocalc-public-prerender="pricing" style="${ARTICLE_STYLE}">
<header>
  <p>CoCalc.ai pricing and licensing</p>
  <h1>Find the right fit</h1>
  <p>The membership options on this page apply to the hosted service on this site. For local, single-VM, and customer-operated paths, continue through the relevant product or contact page.</p>
  <p>${publicLink(basePath, "products", "Compare operating models")}</p>
</header>
<section>
  <h2>Hosted memberships</h2>
  <p>Use CoCalc.ai without operating CoCalc yourself. Current membership tiers, limits, and billing choices appear on this page when it loads.</p>
</section>
<section>
  <h2>For teams and organizations</h2>
  <p>Choose team seats, organization licenses, dedicated project hosts, or a customer-operated product path according to your users, workload, procurement, and operating requirements.</p>
  <p>${publicLink(basePath, "support", "Discuss pricing and licensing")}</p>
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
  const sections = (page.sections ?? [])
    .map((section) => renderSection(section, basePath, config))
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
): string {
  const resolvedConfig = config ?? {};
  if (route.section === "home") {
    return renderHome(basePath);
  }
  if (route.section === "products") {
    return renderProducts(route, basePath, resolvedConfig);
  }
  if (route.section === "pricing") {
    return renderPricing(basePath);
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
