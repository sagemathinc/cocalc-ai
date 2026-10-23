/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { CocalcErrorBoundary } from "@cocalc/frontend/app/error-boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

import { publicPath, type PublicRoute } from "./routes";

function PublicRouteErrorFallback() {
  return (
    <main
      style={{
        background: UI_COLORS.page,
        color: UI_COLORS.text,
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        lineHeight: 1.5,
        margin: "0 auto",
        maxWidth: "48rem",
        padding: "32px 24px",
      }}
    >
      <div role="alert">
        <h1>This page could not be displayed.</h1>
        <p>Reload the page to try again, or go to Home.</p>
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ font: "inherit", padding: "8px 16px", cursor: "pointer" }}
        >
          Reload page
        </button>
        <a href={publicPath("")} style={{ color: UI_COLORS.link }}>
          Go to Home
        </a>
      </div>
    </main>
  );
}

export function PublicRouteErrorBoundary({
  children,
  route,
}: {
  children: ReactNode;
  route: PublicRoute;
}) {
  return (
    <CocalcErrorBoundary
      scope="public.route"
      // Auth/config updates must not retry the same failed route. Include the
      // detail route so navigation within one section can recover too.
      resetKeys={[JSON.stringify(route)]}
      // React caches rejected lazy imports; retrying this subtree alone cannot
      // fetch them again. Only the reader's explicit reload starts a new page.
      fallback={<PublicRouteErrorFallback />}
    >
      {children}
    </CocalcErrorBoundary>
  );
}
