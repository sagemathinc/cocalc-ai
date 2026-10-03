/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { usernameApi } from "@cocalc/server/accounts/usernames";
import { resolvePersonalUrl } from "@cocalc/server/personal-urls";

export const { getUsername, setUsername, releaseRedirect, resolveOwner } =
  usernameApi;
export const resolveUrl = resolvePersonalUrl;
