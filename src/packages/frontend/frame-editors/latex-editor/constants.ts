/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { TIMEOUT_BUILD_JOB_S } from "../generic/build-constants";

export const KNITR_EXTS: ReadonlyArray<string> = ["rnw", "rtex"];

// The maximum we let a job run. Shared with the Rmd/Qmd converters, and
// paired with the coordinator's stale-entry cutoff -- see build-constants.
export const TIMEOUT_LATEX_JOB_S = TIMEOUT_BUILD_JOB_S;

// Icon for word count functionality
export const WORD_COUNT_ICON = "file-alt";
