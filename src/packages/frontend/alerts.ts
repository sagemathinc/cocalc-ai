/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { ReactElement, ReactNode } from "react";

import {
  defaults,
  hash_string,
  server_seconds_ago,
  server_time,
} from "@cocalc/util/misc";

import { getAntdNotificationInstance } from "./app/antd-notification";
import { normalizeUserFacingError } from "./components/user-facing-error";
import { webapp_client } from "./webapp-client";

type NotificationType = "error" | "default" | "success" | "info" | "warning";

const default_timeout: { [key: string]: number } = {
  error: 9,
  default: 6,
  success: 5,
  info: 7,
};

const last_shown = {};

interface AlertMessageOptions {
  type?: NotificationType;
  title?: string | ReactElement<any>;
  message?: ReactNode | Error;
  block?: boolean;
  timeout?: number;
  // Plain text to report for error tracking.  Required when `message` is a
  // react element, since that cannot be logged or deduplicated as-is.
  trackingMessage?: string;
}

export function alert_message(opts: AlertMessageOptions = {}) {
  opts = defaults(opts, {
    type: "default",
    title: undefined,
    message: "",
    block: undefined,
    timeout: undefined, // time in seconds
    trackingMessage: undefined,
  });

  if (opts.type == null) throw Error("bug"); // make typescript happy.

  if (opts.timeout == null) {
    let t: number | undefined = default_timeout[opts.type];
    if (t == null) {
      t = 5;
    }
    opts.timeout = t;
  }

  const trackingMessage = opts.trackingMessage ?? opts.message;

  if (opts.type === "error" && typeof opts.message === "string") {
    opts.message = normalizeUserFacingError(opts.message).message;
  } else if (opts.type === "error" && opts.message instanceof Error) {
    opts.message = normalizeUserFacingError(opts.message).message;
  }

  // Don't show the exact same alert message more than once per 5s.
  // This prevents a screen full of identical useless messages, which
  // is just annoying and useless.
  if (opts.message instanceof Error) {
    opts.message = normalizeUserFacingError(opts.message).message;
  }
  // A react-element message has no text to compare, so fall back to the
  // plain-text version the caller supplied for tracking.  Without this, rich
  // messages silently opt out of deduplication.
  const dedupeKey =
    typeof opts.message === "string"
      ? opts.message
      : typeof trackingMessage === "string"
        ? trackingMessage
        : undefined;
  if (dedupeKey != null) {
    const hash = hash_string(dedupeKey + opts.type);
    if (last_shown[hash] >= server_seconds_ago(5)) {
      return;
    }
    last_shown[hash] = server_time();
  }

  const notification = getAntdNotificationInstance();
  const f =
    opts.type == "default" ? notification.open : notification[opts.type];
  if (f == null) {
    alert(`BUG: Unknown alert_message type ${opts.type}.`);
    return;
  }

  f({
    title: opts.title != null ? opts.title : "",
    description: opts.message,
    duration: opts.block ? 0 : opts.timeout,
  });

  if (opts.type === "error") {
    // Only strings and Errors can be logged: log_error JSON.stringify()s
    // anything else, which throws on a react element's circular fiber refs.
    const tracked = trackingMessage ?? opts.message;
    const loggable =
      typeof tracked === "string" || tracked instanceof Error
        ? tracked
        : typeof opts.title === "string"
          ? opts.title
          : undefined;
    if (loggable == null) return;
    // Send the same error message to the backend hub so
    // that us developers know what errors people are hitting.
    // There really should be no situation where users *regularly*
    // get error alert messages.
    webapp_client.tracking_client.log_error(loggable);
  }
}

// for testing/development
/*
alert_message({ type: "error", message: "This is an error" });
alert_message({ type: "default", message: "This is a default alert" });
alert_message({ type: "warning", message: "This is a warning alert" });
alert_message({ type: "success", message: "This is a success alert" });
alert_message({ type: "info", message: "This is an info alert" });
*/
