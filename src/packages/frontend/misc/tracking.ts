/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { gtag_id, sign_up_id } from "@cocalc/util/theme";

// Conversion tracking is active only when Google Analytics initialized gtag.
export function track_conversion(type: string): void {
  if ((window as any).DEBUG) {
    return;
  }

  let tag: string = "";
  if (type === "create_account") {
    tag = sign_up_id;
  } else {
    console.warn(`unknown conversion type: ${type}`);
    return;
  }

  const gtag = (window as any).gtag;
  if (typeof gtag !== "function") {
    return;
  }
  gtag("event", "conversion", {
    send_to: `${gtag_id}/${tag}`,
  });
}
