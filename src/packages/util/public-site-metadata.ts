/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { LOCALE } from "./i18n/locale";
import { SITE_NAME } from "./theme";

export interface PublicRouteMetadata {
  canonicalPath: string;
  description: string;
  imagePath: string;
  title: string;
}

export interface PublicRouteMetadataConfig {
  cocalc_product?: string;
  is_launchpad?: boolean;
  logo_square?: string;
  site_name?: string;
}

export interface PublicRouteMetadataOptions {
  basePath?: string;
}

export interface PublicMetadataRoute {
  route?: any;
  section: string;
}

interface PublicFeatureMetadata {
  image?: string;
  slug: string;
  summary: string;
  title: string;
}

const DEFAULT_SOCIAL_IMAGE = "public/landing/home-hero.jpg";
const PRODUCT_SOCIAL_IMAGE = "public/landing/product-options.jpg";
const WORKFLOW_SOCIAL_IMAGE = "public/landing/project-workflows.jpg";
const FEATURE_SOCIAL_IMAGE = "public/landing/feature-map.jpg";

const PUBLIC_FEATURE_METADATA: PublicFeatureMetadata[] = [
  {
    slug: "jupyter-notebook",
    title: "Jupyter Notebooks",
    summary:
      "Run Jupyter notebooks inside a shared CoCalc project with collaboration, synchronized output, history, recovery, course workflows, terminals, files, and AI agent context nearby.",
    image: "/public/features/cocalc-jupyter2-20170508.png",
  },
  {
    slug: "latex-editor",
    title: "LaTeX Editor",
    summary:
      "Edit LaTeX in the browser with synchronized collaboration, build output, history, and the rest of the CoCalc project environment close by.",
    image: "/public/features/latex-editor-main-20251003.png",
  },
  {
    slug: "ai",
    title: "AI Agents",
    summary:
      "Work with Codex near files, notebooks, terminals, screenshots, patches, review notes, and live notebook state.",
    image: "/public/features/chatgpt-fix-code.png",
  },
  {
    slug: "slides",
    title: "Slides",
    summary:
      "Build presentation decks from slide-sized whiteboard pages with markdown, math, diagrams, Jupyter cells, collaboration, and project context.",
    image: "/public/features/whiteboard-sage.png",
  },
  {
    slug: "whiteboard",
    title: "Whiteboard",
    summary:
      "Use an infinite collaborative canvas with markdown, KaTeX, Jupyter cells, multiple pages, and a transparent JSONL document format.",
    image: "/public/features/whiteboard-sage.png",
  },
  {
    slug: "r-statistical-software",
    title: "R Statistical Software",
    summary:
      "Work with R in notebooks, terminals, scripts, RMarkdown-style documents, Quarto-style workflows, Knitr, and shared course projects.",
    image: "/public/features/cocalc-r-jupyter.png",
  },
  {
    slug: "sage",
    title: "SageMath",
    summary:
      "Use SageMath for teaching, notebooks, SageTeX documents, source development, and long-running mathematics computations in a real collaborative Linux project.",
    image: "/public/features/sagemath-jupyter.png",
  },
  {
    slug: "octave",
    title: "GNU Octave",
    summary:
      "Use GNU Octave for MATLAB-style numerical computing in collaborative projects with notebooks, .m files, terminals, plots, and teaching workflows.",
    image: "/public/features/cocalc-octave-jupyter-20200511.png",
  },
  {
    slug: "python",
    title: "Python",
    summary:
      "Use Python for technical computing, data science, and machine learning with a large preinstalled package set and collaborative tooling around it.",
    image: "/public/features/frame-editor-python.png",
  },
  {
    slug: "julia",
    title: "Julia",
    summary:
      "Run Julia in a collaborative project with Jupyter notebooks, Pluto, package environments, source files, terminals, and course workflows.",
    image: "/public/features/julia-jupyter.png",
  },
  {
    slug: "terminal",
    title: "Linux Terminal",
    summary:
      "Work in a shared Linux shell, keep tools and files near your notebooks and documents, and avoid local environment drift.",
    image: "/public/features/terminal.png",
  },
  {
    slug: "linux",
    title: "Online Linux Environment",
    summary:
      "Treat CoCalc projects as collaborative Linux environments with editors, terminals, files, and web-accessible services.",
    image: "/public/features/cocalc-shell-script-run.png",
  },
  {
    slug: "teaching",
    title: "Technical Courses and Labs",
    summary:
      "Organize assignments, distribute files, collect work, and grade notebooks or other project files with a workflow built for technical courses, labs, and training environments.",
    image: "/public/features/cocalc-course-assignments-2019.png",
  },
  {
    slug: "api",
    title: "HTTP API",
    summary:
      "Use the CoCalc HTTP API for automation, integration, and provisioning workflows without depending on the web UI.",
    image: "/public/features/api-screenshot.png",
  },
  {
    slug: "compare",
    title: "Compare CoCalc",
    summary:
      "CoCalc combines notebooks, terminals, documents, AI agents, course tools, sharing, recovery, and collaborative editing in one web-based technical workspace.",
  },
  {
    slug: "icons",
    title: "Feature Assets",
    summary:
      "This route is kept available so older links to feature assets still resolve cleanly.",
  },
  {
    slug: "i18n",
    title: "Internationalization",
    summary:
      "CoCalc supports translated public pages and localized product interfaces.",
  },
];

const PUBLIC_FEATURE_METADATA_MAP = new Map(
  PUBLIC_FEATURE_METADATA.map((page) => [page.slug, page]),
);

export const PUBLIC_SITE_DESCRIPTION =
  "CoCalc is a shared project workspace for research, teaching, and technical teams, keeping collaboration, AI assistance, history, and recovery close to the work.";

function normalizeBasePath(basePath?: string): string {
  const trimmed = `${basePath ?? ""}`.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function publicPath(
  view: string,
  options?: PublicRouteMetadataOptions,
): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(view)) return view;
  const base = normalizeBasePath(options?.basePath);
  const normalized = view.replace(/^\/+/, "");
  return normalized ? `${base}/${normalized}` : `${base}/`;
}

function pageTitle(title: string, siteName: string): string {
  return title === siteName ? title : `${title} | ${siteName}`;
}

function hasCustomPublicLogo(config?: PublicRouteMetadataConfig): boolean {
  return !!config?.logo_square?.trim();
}

function usesDefaultLaunchpadPublicBrand(
  config?: PublicRouteMetadataConfig,
): boolean {
  return (
    !hasCustomPublicLogo(config) &&
    config?.site_name === "CoCalc Launchpad" &&
    (config.cocalc_product === "launchpad" || config.is_launchpad === true)
  );
}

function getPublicMarketingSiteName(
  config?: PublicRouteMetadataConfig,
): string {
  if (usesDefaultLaunchpadPublicBrand(config)) return SITE_NAME;
  return config?.site_name ?? SITE_NAME;
}

function routeParts(
  pathname: string,
  options?: PublicRouteMetadataOptions,
): string[] {
  const parts = pathname.split("?")[0].split("#")[0].split("/").filter(Boolean);
  const base = normalizeBasePath(options?.basePath).split("/").filter(Boolean);
  if (base.length === 0) return parts;
  return parts.slice(base.length);
}

function authRoute(parts: string[]): PublicMetadataRoute {
  if (parts[0] === "auth") {
    if (parts[1] === "sign-up") {
      return {
        route: { kind: "auth-form", view: "sign-up" },
        section: "auth",
      };
    }
    if (!parts[1] || parts[1] === "sign-in") {
      return {
        route: { kind: "auth-form", view: "sign-in" },
        section: "auth",
      };
    }
  }
  return { route: { kind: "auth-other" }, section: "auth" };
}

export function getPublicMetadataRouteFromPath(
  pathname: string,
  _search?: string,
  options?: PublicRouteMetadataOptions,
): PublicMetadataRoute {
  const parts = routeParts(pathname, options);
  const section = parts[0];
  if (!section) return { section: "home" };
  if (section === "about") {
    return { route: { view: "about" }, section: "about" };
  }
  if (
    section === "auth" ||
    section === "invites" ||
    section === "redeem" ||
    section === "sso"
  ) {
    return authRoute(parts);
  }
  if (section === "docs") {
    return { route: { view: "docs-index" }, section: "docs" };
  }
  if (section === "features") {
    return {
      route: parts[1] ? { slug: parts[1], view: "detail" } : { view: "index" },
      section: "features",
    };
  }
  if (section === "guides") return { section: "guides" };
  if (section === "news") return { section: "news" };
  if (section === "policies") return { section: "policies" };
  if (section === "pricing") return { section: "pricing" };
  if (section === "products") {
    const detail = parts[1] ? `products-${parts[1]}` : "products";
    return { route: { view: detail }, section: "products" };
  }
  if (section === "support") {
    const view =
      parts[1] === "new" || parts[1] === "tickets" || parts[1] === "community"
        ? parts[1]
        : "index";
    return { route: { view }, section: "support" };
  }
  if (section === "lang" || LOCALE.includes(section as any)) {
    return { route: { locale: parts[1] ?? section }, section: "lang" };
  }
  return { section: "not-found" };
}

function productRouteMetadata(
  route: PublicMetadataRoute["route"],
  siteName: string,
  options?: PublicRouteMetadataOptions,
): PublicRouteMetadata {
  switch (route?.view) {
    case "products-cocalc-plus":
      return {
        canonicalPath: publicPath("products/cocalc-plus", options),
        description:
          "CoCalc Plus is the local, self-directed CoCalc path for evaluating the workspace model on a single machine before choosing hosted or shared deployment.",
        imagePath: publicPath(PRODUCT_SOCIAL_IMAGE, options),
        title: pageTitle("CoCalc Plus", siteName),
      };
    case "products-cocalc-star":
      return {
        canonicalPath: publicPath("products/cocalc-star", options),
        description:
          "CoCalc Star is the single-VM appliance path for a small shared CoCalc site on one public Ubuntu VM.",
        imagePath: publicPath(PRODUCT_SOCIAL_IMAGE, options),
        title: pageTitle("CoCalc Star", siteName),
      };
    case "products-cocalc-launchpad":
      return {
        canonicalPath: publicPath("products/cocalc-launchpad", options),
        description:
          "CoCalc Launchpad is the lightweight customer-operated private deployment path for pilots, labs, workshops, departments, and platform teams.",
        imagePath: publicPath(PRODUCT_SOCIAL_IMAGE, options),
        title: pageTitle("CoCalc Launchpad", siteName),
      };
    case "products-cocalc-rocket":
      return {
        canonicalPath: publicPath("products/cocalc-rocket", options),
        description:
          "CoCalc Rocket is the broader customer-operated private-cloud path for institutions and enterprises planning a larger CoCalc deployment.",
        imagePath: publicPath(PRODUCT_SOCIAL_IMAGE, options),
        title: pageTitle("CoCalc Rocket", siteName),
      };
    case "products":
    default:
      return {
        canonicalPath: publicPath("products", options),
        description:
          "Compare the five CoCalc product paths: hosted CoCalc.ai, local CoCalc Plus, single-VM CoCalc Star, CoCalc Launchpad, and CoCalc Rocket.",
        imagePath: publicPath(PRODUCT_SOCIAL_IMAGE, options),
        title: pageTitle("Ways to Run CoCalc", siteName),
      };
  }
}

function featureRouteMetadata(
  route: PublicMetadataRoute["route"],
  siteName: string,
  options?: PublicRouteMetadataOptions,
): PublicRouteMetadata {
  const page = route?.slug
    ? PUBLIC_FEATURE_METADATA_MAP.get(route.slug)
    : undefined;
  if (route?.slug === "compare") {
    return {
      canonicalPath: publicPath("features/compare", options),
      description:
        "Compare CoCalc by workspace model across notebooks, terminals, files, documents, teaching workflows, AI agents, and deployment options.",
      imagePath: publicPath(FEATURE_SOCIAL_IMAGE, options),
      title: pageTitle("Compare CoCalc", siteName),
    };
  }
  if (route?.slug === "teaching") {
    return {
      canonicalPath: publicPath("features/teaching", options),
      description:
        "CoCalc teaching workflows help instructors run technical course projects with assignments, shared environments, collection, grading, and collaborative help.",
      imagePath: publicPath(WORKFLOW_SOCIAL_IMAGE, options),
      title: pageTitle("Technical Courses and Labs", siteName),
    };
  }
  if (page) {
    return {
      canonicalPath: publicPath(`features/${page.slug}`, options),
      description: page.summary,
      imagePath: publicPath(page.image ?? FEATURE_SOCIAL_IMAGE, options),
      title: pageTitle(page.title, siteName),
    };
  }
  return {
    canonicalPath: publicPath("features", options),
    description:
      "Explore CoCalc features for collaborative notebooks, Linux terminals, technical documents, whiteboards, teaching workflows, automation, and AI agents.",
    imagePath: publicPath(FEATURE_SOCIAL_IMAGE, options),
    title: pageTitle("CoCalc Features", siteName),
  };
}

function authRouteMetadata(
  route: PublicMetadataRoute["route"],
  siteName: string,
  options?: PublicRouteMetadataOptions,
): PublicRouteMetadata {
  if (route?.kind === "auth-form" && route.view === "sign-up") {
    return {
      canonicalPath: publicPath("auth/sign-up", options),
      description:
        "Create a CoCalc account to start hosted projects on CoCalc.ai, explore product paths, and evaluate what fits your team.",
      imagePath: publicPath(DEFAULT_SOCIAL_IMAGE, options),
      title: pageTitle(`Create your ${siteName} account`, siteName),
    };
  }
  if (route?.kind === "auth-form" && route.view === "sign-in") {
    return {
      canonicalPath: publicPath("auth/sign-in", options),
      description:
        "Sign in to CoCalc to open projects, manage your account, and continue work in your collaborative workspace.",
      imagePath: publicPath(DEFAULT_SOCIAL_IMAGE, options),
      title: pageTitle(`Sign in to ${siteName}`, siteName),
    };
  }
  return {
    canonicalPath: publicPath("auth/sign-in", options),
    description:
      "Use your CoCalc account to access projects, collaborators, billing, support, and deployment tools.",
    imagePath: publicPath(DEFAULT_SOCIAL_IMAGE, options),
    title: pageTitle(siteName, siteName),
  };
}

function supportRouteMetadata(
  route: PublicMetadataRoute["route"],
  siteName: string,
  options?: PublicRouteMetadataOptions,
): PublicRouteMetadata {
  switch (route?.view) {
    case "new":
      return {
        canonicalPath: publicPath("support/new", options),
        description:
          "Contact CoCalc about pricing, deployment, product paths, or an existing account or project issue.",
        imagePath: publicPath(WORKFLOW_SOCIAL_IMAGE, options),
        title: pageTitle(`Contact ${siteName} Support`, siteName),
      };
    case "community":
      return {
        canonicalPath: publicPath("support/community", options),
        description:
          "Find CoCalc community channels, documentation, and public support resources.",
        imagePath: publicPath(WORKFLOW_SOCIAL_IMAGE, options),
        title: pageTitle(`${siteName} Community Support`, siteName),
      };
    case "tickets":
      return {
        canonicalPath: publicPath("support/tickets", options),
        description:
          "Review recent CoCalc support tickets when ticket access is available for your account.",
        imagePath: publicPath(WORKFLOW_SOCIAL_IMAGE, options),
        title: pageTitle(`${siteName} Support Tickets`, siteName),
      };
    case "index":
    default:
      return {
        canonicalPath: publicPath("support", options),
        description:
          "Use CoCalc support to choose a product path, discuss pricing or deployment, or get help with an account or project.",
        imagePath: publicPath(WORKFLOW_SOCIAL_IMAGE, options),
        title: pageTitle(`${siteName} Support`, siteName),
      };
  }
}

export function getPublicRouteMetadata(
  route: PublicMetadataRoute,
  config?: PublicRouteMetadataConfig,
  options?: PublicRouteMetadataOptions,
): PublicRouteMetadata {
  const siteName = getPublicMarketingSiteName(config);
  switch (route.section) {
    case "home":
      return {
        canonicalPath: publicPath("", options),
        description: PUBLIC_SITE_DESCRIPTION,
        imagePath: publicPath(DEFAULT_SOCIAL_IMAGE, options),
        title: siteName,
      };
    case "products":
      return productRouteMetadata(route.route, siteName, options);
    case "pricing":
      return {
        canonicalPath: publicPath("pricing", options),
        description:
          "Review CoCalc.ai hosted plans, site licensing, quotes, team seats, and buying paths for hosted, local, single-VM, and customer-operated deployment options.",
        imagePath: publicPath(PRODUCT_SOCIAL_IMAGE, options),
        title: pageTitle("CoCalc.ai Pricing and Licensing", siteName),
      };
    case "features":
      return featureRouteMetadata(route.route, siteName, options);
    case "support":
      return supportRouteMetadata(route.route, siteName, options);
    case "auth":
      return authRouteMetadata(route.route, siteName, options);
    case "guides":
      return {
        canonicalPath: publicPath("guides", options),
        description:
          "Read CoCalc guides for project workflows, notebooks, teaching, automation, and deployment decisions.",
        imagePath: publicPath(FEATURE_SOCIAL_IMAGE, options),
        title: pageTitle("CoCalc Guides", siteName),
      };
    case "docs":
      return {
        canonicalPath: publicPath("docs", options),
        description:
          "Browse CoCalc documentation for projects, files, notebooks, terminals, teaching, account management, and administration.",
        imagePath: publicPath(FEATURE_SOCIAL_IMAGE, options),
        title: pageTitle("CoCalc Documentation", siteName),
      };
    case "about":
      return {
        canonicalPath: publicPath("about", options),
        description:
          "Learn about the people and company behind CoCalc, the collaborative computing platform from SageMath, Inc.",
        imagePath: publicPath(DEFAULT_SOCIAL_IMAGE, options),
        title: pageTitle(`About ${siteName}`, siteName),
      };
    case "news":
      return {
        canonicalPath: publicPath("news", options),
        description:
          "Read CoCalc news, product updates, release notes, and public announcements.",
        imagePath: publicPath(DEFAULT_SOCIAL_IMAGE, options),
        title: pageTitle(`${siteName} News`, siteName),
      };
    case "policies":
      return {
        canonicalPath: publicPath("policies", options),
        description:
          "Review CoCalc public policies, terms, privacy information, and trust resources.",
        imagePath: publicPath(DEFAULT_SOCIAL_IMAGE, options),
        title: pageTitle(`${siteName} Policies`, siteName),
      };
    default:
      return {
        canonicalPath: publicPath("", options),
        description: PUBLIC_SITE_DESCRIPTION,
        imagePath: publicPath(DEFAULT_SOCIAL_IMAGE, options),
        title: siteName,
      };
  }
}
