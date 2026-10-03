/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import {
  COCALC_AI_SIGN_UP_LABEL,
  PUBLIC_SIGN_UP_LABEL,
} from "@cocalc/util/public-site-policy";
import type { PublicRouteMetadataConfig } from "@cocalc/util/public-site-metadata";
import { renderPublicRoutePrerender } from "./public-prerender";

// The same sites as the React test in
// frontend/public/__tests__/cocalc-ai-sign-up.test.tsx, with the same
// expected labels, so the pages and their crawler fallback agree.
const SITES: {
  config: PublicRouteMetadataConfig;
  name: string;
  onCocalcAi: boolean;
}[] = [
  {
    // cocalc.ai's /customize reports the Launchpad product.
    config: {
      cocalc_product: "launchpad",
      dns: "cocalc.ai",
      is_launchpad: true,
      site_name: "CoCalc",
    },
    name: "cocalc.ai",
    onCocalcAi: true,
  },
  {
    config: {
      cocalc_product: "launchpad",
      dns: "compute.example.edu",
      is_launchpad: true,
      site_name: "CoCalc Launchpad",
    },
    name: "another Launchpad host",
    onCocalcAi: false,
  },
  {
    config: {
      cocalc_product: "rocket",
      dns: "cocalc.example.com",
      site_name: "Example Compute",
    },
    name: "a Rocket site",
    onCocalcAi: false,
  },
  {
    config: { cocalc_product: "rocket", dns: "cocalc.ai", site_name: "CoCalc" },
    name: "Rocket on the canonical host",
    onCocalcAi: false,
  },
  {
    config: {
      cocalc_product: "plus",
      dns: "localhost:5000",
      site_name: "CoCalc Plus",
    },
    name: "CoCalc Plus",
    onCocalcAi: false,
  },
];

function featureHtml(slug: string, config: PublicRouteMetadataConfig): string {
  return renderPublicRoutePrerender(
    { section: "features", route: { view: "detail", slug } },
    "/",
    config,
  );
}

describe.each(SITES)(
  "crawler sign-up labels on $name",
  ({ config, onCocalcAi }) => {
    const label = onCocalcAi ? COCALC_AI_SIGN_UP_LABEL : PUBLIC_SIGN_UP_LABEL;

    it("labels the Home sign-up link for the site", () => {
      const html = renderPublicRoutePrerender({ section: "home" }, "/", config);
      expect(html).toContain(`<a href="/auth/sign-up">${label}</a>`);
      if (!onCocalcAi) expect(html).not.toContain(COCALC_AI_SIGN_UP_LABEL);
    });

    it("shows the Terminal record's label only on cocalc.ai", () => {
      expect(getPublicFeaturePage("terminal")?.signUpLabel).toBe(
        COCALC_AI_SIGN_UP_LABEL,
      );
      const html = featureHtml("terminal", config);
      expect(html).toContain(`<a href="/auth/sign-up">${label}</a>`);
      if (!onCocalcAi) expect(html).not.toContain(COCALC_AI_SIGN_UP_LABEL);
    });

    it("keeps the default label on a page without one of its own", () => {
      expect(getPublicFeaturePage("linux")?.signUpLabel).toBeUndefined();
      const html = featureHtml("linux", config);
      expect(html).toContain(
        `<a href="/auth/sign-up">${PUBLIC_SIGN_UP_LABEL}</a>`,
      );
      expect(html).not.toContain(COCALC_AI_SIGN_UP_LABEL);
    });
  },
);
