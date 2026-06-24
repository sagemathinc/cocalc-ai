/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Browser `process` shim for the /design-sync bundle. @cocalc/frontend's dist is
// a shared server+browser tree; some modules read process.env.* (BASE_PATH,
// COCALC_TEST_MODE, NODE_ENV) or call process.emitWarning at module-eval or
// render time. claude.ai/design renders the bundle in a browser sandbox with no
// Node `process`, so define a minimal one BEFORE any component module evaluates.
//
// This module is imported FIRST in index.ts (a side-effect import), so esbuild
// evaluates it ahead of every component module in the IIFE.

const g = globalThis as unknown as {
  process?: { env: Record<string, string | undefined>; emitWarning?: () => void };
};

if (g.process == null) {
  g.process = { env: {}, emitWarning() {} };
}
if (g.process.env == null) {
  g.process.env = {};
}
if (g.process.env.NODE_ENV == null) g.process.env.NODE_ENV = "development";
if (g.process.env.BASE_PATH == null) g.process.env.BASE_PATH = "";
if (typeof g.process.emitWarning !== "function") g.process.emitWarning = () => {};

export {};
