/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const COCALC_AI_ORIGIN = "https://cocalc.ai";

// Only paths verified to have a canonical destination on cocalc.ai belong
// here. Unclassified paths retain the temporary redirect until reviewed.
const PERMANENT_PATHS = new Set([
  "/",
  "/about",
  "/about/events",
  "/about/team",
  "/about/team/andrey-novoseltsev",
  "/about/team/blaec-bejarano",
  "/about/team/harald-schilly",
  "/about/team/william-stein",
  "/ar",
  "/br",
  "/de",
  "/docs",
  "/en",
  "/es",
  "/eu",
  "/features",
  "/features/ai",
  "/features/api",
  "/features/compare",
  "/features/julia",
  "/features/jupyter-notebook",
  "/features/latex-editor",
  "/features/linux",
  "/features/octave",
  "/features/python",
  "/features/r-statistical-software",
  "/features/sage",
  "/features/slides",
  "/features/teaching",
  "/features/terminal",
  "/features/whiteboard",
  "/fr",
  "/guides",
  "/he",
  "/hi",
  "/hu",
  "/info",
  "/it",
  "/ja",
  "/ko",
  "/lang",
  "/news",
  "/nl",
  "/pl",
  "/policies",
  "/policies/accessibility",
  "/policies/copyright",
  "/policies/dpa",
  "/policies/ferpa",
  "/policies/privacy",
  "/policies/terms",
  "/policies/trust",
  "/pricing",
  "/pricing/courses",
  "/pricing/onprem",
  "/pricing/products",
  "/pricing/subscriptions",
  "/products",
  "/products/cocalc-launchpad",
  "/products/cocalc-plus",
  "/products/cocalc-rocket",
  "/products/cocalc-star",
  "/pt",
  "/rootfs",
  "/ru",
  "/support",
  "/support/community",
  "/support/new",
  "/tr",
  "/zh",
]);

const REMOVED_PATH_ROOTS = ["/github", "/gist", "/rajacuan"];

function normalizedPath(pathname) {
  if (pathname === "/") {
    return pathname;
  }
  return pathname.replace(/\/+$/, "") || "/";
}

function matchesPathRoot(pathname, root) {
  return pathname === root || pathname.startsWith(`${root}/`);
}

function targetUrl(source, pathname = source.pathname) {
  const target = new URL(COCALC_AI_ORIGIN);
  target.pathname = pathname;
  target.search = source.search;
  return target;
}

function legacyResolverPath(pathname) {
  if (pathname === "/legacy" || pathname.startsWith("/legacy/")) {
    return pathname;
  }
  return `/legacy${pathname}`;
}

function redirect(location, status, policy) {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": status === 302 ? "no-store" : "public, max-age=3600",
      Location: location.toString(),
      "X-CoCalc-Migration-Policy": policy,
    },
  });
}

function gone(method) {
  const body =
    method === "HEAD"
      ? null
      : [
          "<!doctype html>",
          '<html lang="en"><head><meta charset="utf-8">',
          '<meta name="robots" content="noindex,nofollow,noarchive">',
          "<title>Content no longer available</title></head><body>",
          "<h1>Content no longer available</h1>",
          "<p>This historical cocalc.com content has been removed.</p>",
          '<p>CoCalc is now available at <a href="https://cocalc.ai/">cocalc.ai</a>.</p>',
          "</body></html>",
        ].join("");
  return new Response(body, {
    status: 410,
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "text/html; charset=utf-8",
      "X-CoCalc-Migration-Policy": "removed",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

export function classifyUrl(value) {
  const source = value instanceof URL ? value : new URL(value);
  const pathname = normalizedPath(source.pathname);
  const lowerPath = pathname.toLowerCase();

  if (REMOVED_PATH_ROOTS.some((root) => matchesPathRoot(lowerPath, root))) {
    return { kind: "removed", status: 410 };
  }

  const cambridge = pathname.match(/^\/cambridge(?:\/(.*))?$/i);
  if (cambridge) {
    const suffix = cambridge[1] ? `/${cambridge[1]}` : "";
    return {
      kind: "cambridge",
      location: targetUrl(source, `/share/Cambridge${suffix}`),
      status: 301,
    };
  }

  if (PERMANENT_PATHS.has(pathname)) {
    return {
      kind: "permanent",
      location: targetUrl(source, pathname),
      status: 308,
    };
  }

  return {
    kind: "temporary",
    location: targetUrl(source, legacyResolverPath(source.pathname)),
    status: 302,
  };
}

export function handleRequest(request) {
  const result = classifyUrl(request.url);
  if (result.kind === "removed") {
    return gone(request.method);
  }
  return redirect(result.location, result.status, result.kind);
}

export default {
  fetch(request) {
    return handleRequest(request);
  },
};
