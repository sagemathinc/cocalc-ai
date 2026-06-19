/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Public-site design-system barrel — the curated component surface that
// /design-sync imports into claude.ai/design. Additive only: this re-exports
// existing components so the converter has one entry + a types root scoped to
// the public design system (via package.json `publishConfig.types`), without
// touching the rest of @cocalc/frontend's module/type resolution.
//
// Wave 1: the redux-free, config-free, dist-clean presentational primitives.
// (Shell/nav/footer and the CoCalc-routed CTA helpers come in later waves once
// their appBasePath/PublicConfig coupling is stubbed.)

// MUST be first — defines a browser `process` global before any component module
// evaluates (the shared dist tree reads process.env.*). See _ds-process-shim.ts.
import "./_ds-process-shim";

export {
  PublicHero,
  PublicSection,
  PublicCard,
  PublicGrid,
  PUBLIC_PAGE_CSS,
} from "./layout/shell";

export {
  IconBadge,
  StoryCard,
  ContextList,
  TerminalMock,
  StartCard,
} from "./features/feature-visuals";

export { CodeBlock, LinkButton, LoadingSection, EmptySection } from "./common";

// Preview provider (not a card — excluded via cfg.componentSrcMap; present in the
// bundle so the converter can wrap previews in cfg.provider).
export { DSProvider } from "./_ds-provider";
