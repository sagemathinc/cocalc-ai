/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Keep element registration side effects alive in production bundles.
// Re-exporting from "./types" is not sufficient because rspack can tree-shake
// the re-export while still leaving callers able to import register helpers.
import "./types";

export * from "./register";
export { isElementOfType } from "./types";
