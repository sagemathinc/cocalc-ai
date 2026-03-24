/*
 *  This file is part of CoCalc: Copyright (C) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { joinUrlPath } from "@cocalc/util/url-path";

export function getWebpackPublicPath(basePath: string): string {
  return `${joinUrlPath(basePath, "static")}/`;
}
