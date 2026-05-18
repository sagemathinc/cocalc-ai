/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Provide a typescript-friendly stable interface to user_tracking, so
// client code doesn't have to import webapp_client everywhere, and we can
// completely change this if we want.

import { webapp_client } from "./webapp-client";

// This function will never raise an exception -- instead it
// shows a warning in the console when it can't report to the backend.
export default async function track(
  event: string,
  value: object,
): Promise<void> {
  // Replace all dashes with underscores in the event argument for consistency
  event = event.replace(/-/g, "_");

  // console.log("user_tracking", event, value);
  try {
    await webapp_client.tracking_client.user_tracking(event, value);
  } catch {
    //console.warn("user_tracking", { event, value }, err);
  }
}
