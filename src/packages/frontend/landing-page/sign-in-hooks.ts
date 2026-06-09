/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { webapp_client } from "../webapp-client";
import { SignedIn } from "@cocalc/util/message-types";
import { join } from "path";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { lite } from "@cocalc/frontend/lite";
import { store as customizeStore } from "@cocalc/frontend/customize";

async function analytics_send(mesg: SignedIn): Promise<void> {
  if (lite) {
    return;
  }
  await customizeStore.until_configured();
  if (customizeStore.get("cookie_banner_enabled")) {
    const { hasTrackingConsent } =
      await import("@cocalc/frontend/cookie-consent");
    if (!hasTrackingConsent()) return;
  }
  window
    .fetch(join(appBasePath, "analytics.js"), {
      method: "POST",
      cache: "no-cache",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      redirect: "follow",
      body: JSON.stringify({
        account_id: mesg.account_id,
      }),
    })
    // .then(response => console.log("Success:", response))
    .catch((error) =>
      console.log("WARNING: sign-in-hooks::analytics_send error:", error),
    );
}

// Launch actions step 1: store any launch action information
import * as launch_actions from "../launch/actions";
launch_actions.store();

webapp_client.on("signed_in", (mesg: SignedIn) => {
  // console.log("sign-in-hooks::signed_in mesg=", mesg);
  // launch actions step 2: launch based on local storage
  launch_actions.launch();
  analytics_send(mesg);
});
