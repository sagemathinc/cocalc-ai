/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The built-in policies without JavaScript: /policies/<slug>.md serves each
// one as Markdown, the policy pages' prerendered body has its full text, and
// /llms.txt links the Markdown. The Markdown is generated from the React
// policy pages (frontend/public/policies/markdown.ts), and a frontend test
// checks the copy in @cocalc/util is current, so all of these say exactly
// what the pages say.

import MarkdownIt from "markdown-it";
import type { Request, Response, Router } from "express";

import basePath from "@cocalc/backend/base-path";
import getCustomize from "@cocalc/database/settings/customize";
import { getLogger } from "@cocalc/hub/logger";
import {
  PUBLIC_POLICY_MARKDOWN,
  type PublicPolicyMarkdown,
} from "@cocalc/util/public-policies-markdown.generated";
import {
  getExternalPoliciesUrl,
  getPublicPolicyPages,
  type PublicMetadataRoute,
  type PublicRouteMetadataConfig,
} from "@cocalc/util/public-site-metadata";
import { joinUrlPath } from "@cocalc/util/url-path";

const logger = getLogger("hub:servers:public-policies");

type PolicyConfig = Pick<
  PublicRouteMetadataConfig,
  "policy_pages" | "terms_of_service_url"
>;

// The same gate as the policy pages (policiesRouteMetadata and the client):
// the built-in SageMath, Inc. documents exist only in "sagemathinc" mode
// without an external policies URL.
export function builtinPolicies(
  config?: PolicyConfig,
): readonly PublicPolicyMarkdown[] {
  return getPublicPolicyPages(config) === "sagemathinc" &&
    getExternalPoliciesUrl(config) == null
    ? PUBLIC_POLICY_MARKDOWN
    : [];
}

export function builtinPolicy(
  slug: string,
  config?: PolicyConfig,
): PublicPolicyMarkdown | undefined {
  return builtinPolicies(config).find((policy) => policy.slug === slug);
}

export function policyMarkdownPath(slug: string): string {
  return `/policies/${slug}.md`;
}

// Links in the policies are written relative to the site root.
export function resolvePolicyLinks(markdown: string, siteUrl: string): string {
  const prefix = siteUrl.replace(/\/+$/, "");
  return markdown.replace(/\]\(\/(?!\/)/g, `](${prefix}/`);
}

const md = new MarkdownIt({ html: false, linkify: false });

const ARTICLE_STYLE = [
  "box-sizing:border-box",
  "font-family:ui-sans-serif,sans-serif",
  "line-height:1.6",
  "margin:0 auto",
  "max-width:80ch",
  "padding:48px 24px",
  "overflow-wrap:anywhere",
].join(";");

function sitePath(path: string): string {
  return joinUrlPath(basePath, path);
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The policy pages' prerendered body: the whole policy for a policy page and
// the list of policies for /policies. It shares the public shell's cache
// policy and uses no account state.
export function renderPublicPoliciesPrerender(
  route: PublicMetadataRoute,
  config: PublicRouteMetadataConfig,
): string {
  if (route.section !== "policies") return "";
  const view = route.route?.view;
  if (view === "policies-detail") {
    const policy = builtinPolicy(route.route?.policySlug ?? "", config);
    if (policy == null) return "";
    const html = md.render(resolvePolicyLinks(policy.markdown, sitePath("/")));
    const source = sitePath(policyMarkdownPath(policy.slug));
    return `<article data-cocalc-public-prerender="policy" style="${ARTICLE_STYLE}">
${html}<p><a href="${htmlEscape(source)}">This policy as Markdown</a></p>
</article>`;
  }
  if (view === "policies") {
    const policies = builtinPolicies(config);
    if (policies.length === 0) return "";
    const items = policies
      .map(
        (policy) =>
          `<li><a href="${htmlEscape(sitePath(`/policies/${policy.slug}`))}">${htmlEscape(policy.title)}</a> (<a href="${htmlEscape(sitePath(policyMarkdownPath(policy.slug)))}">Markdown</a>): ${htmlEscape(policy.description)}</li>`,
      )
      .join("\n");
    return `<article data-cocalc-public-prerender="policies" style="${ARTICLE_STYLE}">
<h1>Policies</h1>
<ul>
${items}
</ul>
</article>`;
  }
  return "";
}

function requestSiteUrl(req: Request): string {
  return `${req.protocol}://${req.get("host")}${sitePath("/")}`;
}

export function servePolicyMarkdown(req: Request, res: Response): void {
  const params = req.params as Record<string, string | undefined>;
  const slug = `${params.slug ?? params[0] ?? ""}`;
  void (async () => {
    const customize = await getCustomize();
    const policy = builtinPolicy(slug, {
      policy_pages: customize?.policy_pages,
      terms_of_service_url: customize?.termsOfServiceURL,
    });
    if (policy == null) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    // Absolute links depend on the host the request came to.
    res.vary("Host");
    res.type("text/markdown; charset=utf-8");
    res.header("Cache-Control", "public, max-age=3600, must-revalidate");
    res.send(resolvePolicyLinks(policy.markdown, requestSiteUrl(req)));
  })().catch((err) => {
    logger.warn("policy markdown failed", { err: `${err}` });
    res.status(500).type("text/plain").send("internal error");
  });
}

// Registered before the public content routes, whose /policies/:slug would
// otherwise take "terms.md" as a page slug.
export default function initPublicPolicies(router: Router): void {
  router.get(/^\/policies\/(?<slug>[a-z0-9-]+)\.md$/, servePolicyMarkdown);
}
