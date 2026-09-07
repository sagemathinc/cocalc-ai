/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { connect } from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";
import {
  parseAppearancePreference,
  type AppearancePreference,
} from "@cocalc/util/appearance";
import callHub from "./call-hub";

// Lightweight entries load this transport only on an explicit save. The route
// comes from authenticated bootstrap, never from the cosmetic local theme cache.
export async function saveAccountAppearance(
  { account_id, home_bay_url }: { account_id: string; home_bay_url: string },
  preference: AppearancePreference,
  appBasePath = "/",
): Promise<void> {
  if (!account_id || !home_bay_url || !parseAppearancePreference(preference)) {
    throw Error("Invalid account appearance request");
  }
  const client = connect({
    address:
      `${home_bay_url.replace(/\/+$/, "")}/${appBasePath.replace(/^\/+|\/+$/g, "")}`.replace(
        /\/+$/,
        "",
      ),
    inboxPrefix: inboxPrefix({ account_id }),
    forceNew: true,
    noCache: true,
  });
  try {
    await client.waitUntilSignedIn({ timeout: 15_000 });
    const result = await callHub({
      client,
      account_id,
      name: "db.userQuery",
      args: [
        {
          query: {
            accounts: {
              account_id,
              other_settings: { appearance_theme: preference },
            },
          },
          options: [],
        },
      ],
    });
    if (result?.error) throw Error("Account appearance save failed");
  } finally {
    client.close();
  }
}
