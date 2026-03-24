/*
 *  This file is part of CoCalc: Copyright © 2021 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";

// subset of CustomizeState
export interface Customize {
  logo_rectangular: string;
  logo_square: string;
}

export const DEFAULT_CUSTOMIZE: Customize = {
  logo_rectangular: "",
  logo_square: joinUrlPath(appBasePath, "webapp/favicon.ico"),
};
