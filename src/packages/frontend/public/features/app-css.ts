/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// CSS blocks for the public features app (app.tsx), kept as template
// strings so they can interpolate the shared public theme constants.

import {
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";

export const FEATURE_INDEX_CSS = `
  .cocalc-feature-index-hero {
    padding: 32px 0 12px;
  }

  .cocalc-feature-index-title {
    font-size: 58px !important;
    line-height: 1.02 !important;
    max-width: 900px;
    text-wrap: balance;
  }

  .cocalc-feature-link-card-combined {
    cursor: default;
  }

  .cocalc-feature-link-card-primary {
    color: inherit;
    display: block;
    flex: 1 1 auto;
    text-decoration: none;
  }

  .cocalc-feature-link-card-secondary {
    align-items: center;
    align-self: flex-start;
    color: ${PUBLIC_COLORS.link};
    display: inline-flex;
    font-weight: 600;
    gap: 6px;
    margin-top: 14px;
    text-decoration: none;
  }

  .cocalc-feature-link-card-secondary:hover {
    color: ${PUBLIC_COLORS.linkHover};
    text-decoration: underline;
  }

  .cocalc-feature-link-card-primary:focus-visible,
  .cocalc-feature-link-card-secondary:focus-visible {
    outline: 2px solid ${PUBLIC_COLORS.linkHover};
    outline-offset: 3px;
  }

  .cocalc-feature-link-list {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  }

  .cocalc-feature-teaching-callout {
    padding-bottom: 28px;
  }

  @media (max-width: 920px) {
    .cocalc-feature-index-title {
      font-size: 42px !important;
      line-height: 1.08 !important;
    }
  }

  @media (max-width: 560px) {
    .cocalc-feature-index-hero {
      gap: 28px;
      padding: 20px 0 4px;
    }

    .cocalc-feature-index-title {
      font-size: 34px !important;
    }

    .cocalc-feature-link-card {
      min-height: 0 !important;
      padding: 14px !important;
    }

    .cocalc-feature-list-link {
      min-height: 82px !important;
      padding: 12px !important;
    }

    .cocalc-feature-link-list {
      grid-template-columns: minmax(0, 1fr) !important;
    }

    .cocalc-feature-teaching-callout {
      padding-bottom: 20px;
    }
  }
`;

// Sub-section bar shown on every feature page (like the old cocalc.com
// features header): jump directly between feature pages without going back
// to the index. Short labels — the full titles live on the pages themselves.
export const FEATURE_SUBNAV_CSS = `
  /* The pill list exists only as the fixed side rail on wide viewports,
     where the content column (max 1200px) leaves free margin to park it
     in. Everywhere else navigation goes through the "Features" dropdown
     in the public top nav (layout/top-nav.tsx) — never pills on top. */
  .cocalc-feature-subnav {
    display: none;
  }

  @media (min-width: 1560px) {
    .cocalc-feature-subnav {
      display: block;
      left: calc((100vw - 1200px) / 2 - 176px);
      max-height: calc(100vh - 128px);
      overflow-y: auto;
      position: fixed;
      top: 96px;
      width: 152px;
      z-index: 10;
    }

    .cocalc-feature-subnav-list {
      align-items: stretch;
      display: flex;
      flex-direction: column;
      gap: 8px;
      justify-content: flex-start;
    }
  }

  .cocalc-feature-subnav-pill {
    align-items: center;
    background: ${PUBLIC_COLORS.surface};
    border: 1px solid ${PUBLIC_COLORS.border};
    border-radius: ${PUBLIC_RADIUS.pill}px;
    color: ${PUBLIC_COLORS.text};
    display: inline-flex;
    font-size: ${PUBLIC_TYPE.caption}px;
    gap: 7px;
    line-height: 1;
    padding: 6px 13px;
    text-decoration: none;
    transition: border-color 140ms ease, color 140ms ease;
    white-space: nowrap;
  }

  .cocalc-feature-subnav-pill:hover {
    border-color: ${PUBLIC_COLORS.linkHover};
    color: ${PUBLIC_COLORS.linkHover};
  }

  .cocalc-feature-subnav-pill:focus-visible {
    outline: 2px solid ${PUBLIC_COLORS.linkHover};
    outline-offset: 2px;
  }

  .cocalc-feature-subnav-pill[aria-current="page"] {
    background: ${PUBLIC_COLORS.brandSubtle};
    border-color: ${PUBLIC_COLORS.brand};
    color: ${PUBLIC_COLORS.brandDark};
    font-weight: 600;
  }
`;
