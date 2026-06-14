/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo } from "react";

import { getPublicMarketingSiteName, type PublicConfig } from "./config";
import { getFeaturePage } from "./features/catalog";
import type { PublicRoute } from "./routes";
import { publicPath } from "./routes";

export interface PublicRouteMetadata {
  canonicalPath: string;
  description: string;
  imagePath: string;
  title: string;
}

const DEFAULT_SOCIAL_IMAGE = "/public/landing/home-hero.jpg";
const PRODUCT_SOCIAL_IMAGE = "/public/landing/product-options.jpg";
const WORKFLOW_SOCIAL_IMAGE = "/public/landing/project-workflows.jpg";
const FEATURE_SOCIAL_IMAGE = "/public/landing/feature-map.jpg";

export const PUBLIC_SITE_DESCRIPTION =
  "CoCalc is a collaborative workspace for research, teaching, and teams, with notebooks, code, documents, terminals, compute, course workflows, and AI in shared projects.";

function absolutePublicUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).href;
}

function pageTitle(title: string, siteName: string): string {
  return title === siteName ? title : `${title} | ${siteName}`;
}

function productRouteMetadata(
  route: Extract<PublicRoute, { section: "products" }>["route"],
  siteName: string,
): PublicRouteMetadata {
  switch (route.view) {
    case "products-cocalc-plus":
      return {
        canonicalPath: publicPath("products/cocalc-plus"),
        description:
          "CoCalc Plus is the local, self-directed CoCalc path for evaluating the workspace model on a single machine before choosing hosted or shared deployment.",
        imagePath: PRODUCT_SOCIAL_IMAGE,
        title: pageTitle("CoCalc Plus", siteName),
      };
    case "products-cocalc-star":
      return {
        canonicalPath: publicPath("products/cocalc-star"),
        description:
          "CoCalc Star is the single-VM appliance path for a small shared CoCalc site on one public Ubuntu VM.",
        imagePath: PRODUCT_SOCIAL_IMAGE,
        title: pageTitle("CoCalc Star", siteName),
      };
    case "products-cocalc-launchpad":
      return {
        canonicalPath: publicPath("products/cocalc-launchpad"),
        description:
          "CoCalc Launchpad is the lightweight customer-operated private deployment path for pilots, labs, workshops, departments, and platform teams.",
        imagePath: PRODUCT_SOCIAL_IMAGE,
        title: pageTitle("CoCalc Launchpad", siteName),
      };
    case "products-cocalc-rocket":
      return {
        canonicalPath: publicPath("products/cocalc-rocket"),
        description:
          "CoCalc Rocket is the broader customer-operated private-cloud path for institutions and enterprises planning a larger CoCalc deployment.",
        imagePath: PRODUCT_SOCIAL_IMAGE,
        title: pageTitle("CoCalc Rocket", siteName),
      };
    case "products":
    default:
      return {
        canonicalPath: publicPath("products"),
        description:
          "Compare the five CoCalc product paths: hosted CoCalc.ai, local CoCalc Plus, single-VM CoCalc Star, CoCalc Launchpad, and CoCalc Rocket.",
        imagePath: PRODUCT_SOCIAL_IMAGE,
        title: pageTitle("Ways to Run CoCalc", siteName),
      };
  }
}

function featureRouteMetadata(
  route: Extract<PublicRoute, { section: "features" }>["route"],
  siteName: string,
): PublicRouteMetadata {
  const page = route.slug ? getFeaturePage(route.slug) : undefined;
  if (route.slug === "compare") {
    return {
      canonicalPath: publicPath("features/compare"),
      description:
        "Compare CoCalc by workspace model across notebooks, terminals, files, documents, teaching workflows, AI agents, and deployment options.",
      imagePath: FEATURE_SOCIAL_IMAGE,
      title: pageTitle("Compare CoCalc", siteName),
    };
  }
  if (route.slug === "teaching") {
    return {
      canonicalPath: publicPath("features/teaching"),
      description:
        "CoCalc teaching workflows help instructors run technical course projects with assignments, shared environments, collection, grading, and collaborative help.",
      imagePath: WORKFLOW_SOCIAL_IMAGE,
      title: pageTitle("Technical Courses and Labs", siteName),
    };
  }
  if (page) {
    return {
      canonicalPath: publicPath(`features/${page.slug}`),
      description: page.summary,
      imagePath: page.image ?? FEATURE_SOCIAL_IMAGE,
      title: pageTitle(page.title, siteName),
    };
  }
  return {
    canonicalPath: publicPath("features"),
    description:
      "Explore CoCalc features for collaborative notebooks, Linux terminals, technical documents, whiteboards, teaching workflows, automation, and AI agents.",
    imagePath: FEATURE_SOCIAL_IMAGE,
    title: pageTitle("CoCalc Features", siteName),
  };
}

function authRouteMetadata(
  route: Extract<PublicRoute, { section: "auth" }>["route"],
  siteName: string,
): PublicRouteMetadata {
  if (route.kind === "auth-form" && route.view === "sign-up") {
    return {
      canonicalPath: publicPath("auth/sign-up"),
      description:
        "Create a CoCalc account to start hosted projects on CoCalc.ai, explore product paths, and evaluate what fits your team.",
      imagePath: DEFAULT_SOCIAL_IMAGE,
      title: pageTitle(`Create your ${siteName} account`, siteName),
    };
  }
  if (route.kind === "auth-form" && route.view === "sign-in") {
    return {
      canonicalPath: publicPath("auth/sign-in"),
      description:
        "Sign in to CoCalc to open projects, manage your account, and continue work in your collaborative workspace.",
      imagePath: DEFAULT_SOCIAL_IMAGE,
      title: pageTitle(`Sign in to ${siteName}`, siteName),
    };
  }
  return {
    canonicalPath: publicPath("auth/sign-in"),
    description:
      "Use your CoCalc account to access projects, collaborators, billing, support, and deployment tools.",
    imagePath: DEFAULT_SOCIAL_IMAGE,
    title: pageTitle(siteName, siteName),
  };
}

function supportRouteMetadata(
  route: Extract<PublicRoute, { section: "support" }>["route"],
  siteName: string,
): PublicRouteMetadata {
  switch (route.view) {
    case "new":
      return {
        canonicalPath: publicPath("support/new"),
        description:
          "Contact CoCalc about pricing, deployment, product paths, or an existing account or project issue.",
        imagePath: WORKFLOW_SOCIAL_IMAGE,
        title: pageTitle(`Contact ${siteName} Support`, siteName),
      };
    case "community":
      return {
        canonicalPath: publicPath("support/community"),
        description:
          "Find CoCalc community channels, documentation, and public support resources.",
        imagePath: WORKFLOW_SOCIAL_IMAGE,
        title: pageTitle(`${siteName} Community Support`, siteName),
      };
    case "tickets":
      return {
        canonicalPath: publicPath("support/tickets"),
        description:
          "Review recent CoCalc support tickets when ticket access is available for your account.",
        imagePath: WORKFLOW_SOCIAL_IMAGE,
        title: pageTitle(`${siteName} Support Tickets`, siteName),
      };
    case "index":
    default:
      return {
        canonicalPath: publicPath("support"),
        description:
          "Use CoCalc support to choose a product path, discuss pricing or deployment, or get help with an account or project.",
        imagePath: WORKFLOW_SOCIAL_IMAGE,
        title: pageTitle(`${siteName} Support`, siteName),
      };
  }
}

export function getPublicRouteMetadata(
  route: PublicRoute,
  config?: PublicConfig,
): PublicRouteMetadata {
  const siteName = getPublicMarketingSiteName(config);
  switch (route.section) {
    case "home":
      return {
        canonicalPath: publicPath(""),
        description: PUBLIC_SITE_DESCRIPTION,
        imagePath: DEFAULT_SOCIAL_IMAGE,
        title: siteName,
      };
    case "products":
      return productRouteMetadata(route.route, siteName);
    case "pricing":
      return {
        canonicalPath: publicPath("pricing"),
        description:
          "Review CoCalc.ai hosted plans, site licensing, quotes, team seats, and buying paths for hosted, local, single-VM, and customer-operated deployment options.",
        imagePath: PRODUCT_SOCIAL_IMAGE,
        title: pageTitle("CoCalc.ai Pricing and Licensing", siteName),
      };
    case "features":
      return featureRouteMetadata(route.route, siteName);
    case "support":
      return supportRouteMetadata(route.route, siteName);
    case "auth":
      return authRouteMetadata(route.route, siteName);
    case "guides":
      return {
        canonicalPath: publicPath("guides"),
        description:
          "Read CoCalc guides for project workflows, notebooks, teaching, automation, and deployment decisions.",
        imagePath: FEATURE_SOCIAL_IMAGE,
        title: pageTitle("CoCalc Guides", siteName),
      };
    case "docs":
      return {
        canonicalPath: publicPath("docs"),
        description:
          "Browse CoCalc documentation for projects, files, notebooks, terminals, teaching, account management, and administration.",
        imagePath: FEATURE_SOCIAL_IMAGE,
        title: pageTitle("CoCalc Documentation", siteName),
      };
    case "about":
      return {
        canonicalPath: publicPath("about"),
        description:
          "Learn about the people and company behind CoCalc, the collaborative computing platform from SageMath, Inc.",
        imagePath: DEFAULT_SOCIAL_IMAGE,
        title: pageTitle(`About ${siteName}`, siteName),
      };
    default:
      return {
        canonicalPath: publicPath(""),
        description: PUBLIC_SITE_DESCRIPTION,
        imagePath: DEFAULT_SOCIAL_IMAGE,
        title: siteName,
      };
  }
}

function upsertManagedElement<T extends HTMLMetaElement | HTMLLinkElement>({
  attrs,
  tag,
  key,
}: {
  attrs: Record<string, string>;
  key: string;
  tag: "link" | "meta";
}): T {
  let element = document.head.querySelector<T>(
    `${tag}[data-cocalc-public-route-meta="${key}"]`,
  );
  if (element == null) {
    element = document.createElement(tag) as T;
    element.setAttribute("data-cocalc-public-route-meta", key);
    document.head.appendChild(element);
  }
  for (const attr of Array.from(element.attributes)) {
    if (attr.name !== "data-cocalc-public-route-meta") {
      element.removeAttribute(attr.name);
    }
  }
  element.setAttribute("data-cocalc-public-route-meta", key);
  for (const [name, value] of Object.entries(attrs)) {
    element.setAttribute(name, value);
  }
  return element;
}

export function applyPublicRouteMetadata(metadata: PublicRouteMetadata): void {
  const canonicalUrl = absolutePublicUrl(metadata.canonicalPath);
  const imageUrl = absolutePublicUrl(metadata.imagePath);

  upsertManagedElement<HTMLMetaElement>({
    attrs: { content: metadata.description, name: "description" },
    key: "description",
    tag: "meta",
  });
  upsertManagedElement<HTMLLinkElement>({
    attrs: { href: canonicalUrl, rel: "canonical" },
    key: "canonical",
    tag: "link",
  });

  for (const [property, content] of [
    ["og:type", "website"],
    ["og:title", metadata.title],
    ["og:description", metadata.description],
    ["og:url", canonicalUrl],
    ["og:image", imageUrl],
  ] as const) {
    upsertManagedElement<HTMLMetaElement>({
      attrs: { content, property },
      key: property,
      tag: "meta",
    });
  }

  for (const [name, content] of [
    ["twitter:card", "summary_large_image"],
    ["twitter:title", metadata.title],
    ["twitter:description", metadata.description],
    ["twitter:image", imageUrl],
  ] as const) {
    upsertManagedElement<HTMLMetaElement>({
      attrs: { content, name },
      key: name,
      tag: "meta",
    });
  }
}

export function PublicRouteHeadMetadata({
  config,
  route,
}: {
  config?: PublicConfig;
  route: PublicRoute;
}) {
  const metadata = useMemo(
    () => getPublicRouteMetadata(route, config),
    [config, route],
  );

  useEffect(() => {
    applyPublicRouteMetadata(metadata);
  }, [metadata]);

  return null;
}
