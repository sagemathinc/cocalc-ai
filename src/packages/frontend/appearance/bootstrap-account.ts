/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { AuthBootstrapResponse } from "@cocalc/frontend/auth/api";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getBrowserAppearanceStore } from "@cocalc/util/appearance-browser";
import { parseAppearancePreference } from "@cocalc/util/appearance";

// Called with existing bootstrap data, not by fetching account state solely for
// a public page's theme. In particular, anonymous docs remain auth-independent.
export function receiveAppearanceBootstrap(bootstrap: AuthBootstrapResponse) {
  const store = getBrowserAppearanceStore();
  const { signed_in, account_id, home_bay_url, appearance_theme } = bootstrap;
  if (!signed_in) {
    store.receiveAccount(undefined);
  } else if (account_id && home_bay_url) {
    store.receiveAccount(
      account_id,
      parseAppearancePreference(appearance_theme),
      async (preference) => {
        const { saveAccountAppearance } =
          await import("@cocalc/conat/hub/account-appearance");
        await saveAccountAppearance(
          { account_id, home_bay_url },
          preference,
          appBasePath,
        );
      },
    );
  }
}
