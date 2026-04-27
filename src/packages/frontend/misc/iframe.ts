/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { delay } from "awaiting";
import $ from "jquery";

const DOWNLOAD_ERROR_HEADER = "X-CoCalc-Download-Error";

function decodeDownloadErrorHeader(value: string | null): string | undefined {
  if (!value) return;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function assertDownloadAllowed(src: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(src, {
      method: "HEAD",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (err) {
    throw Error(`Unable to start download -- ${err}`);
  }
  if (response.ok) return;
  const detailed =
    decodeDownloadErrorHeader(response.headers.get(DOWNLOAD_ERROR_HEADER)) ??
    response.statusText;
  if (detailed) {
    throw Error(detailed);
  }
  throw Error(`Unable to start download (HTTP ${response.status})`);
}

// Cause a file at a given url to get downloaded using an iframe.
// Awaiting this only waits for the preflight and iframe creation, not the full browser download.
export async function download_file(src: string): Promise<void> {
  await assertDownloadAllowed(src);
  // NOTE: the file has to be served with
  //    res.setHeader('Content-disposition', 'attachment')

  // Create hidden iframe that causes download to happen:
  const iframe = $("<iframe>")
    .addClass("hide")
    .attr("src", src)
    .appendTo($("body"));

  void (async () => {
    // Wait a minute...
    await delay(60000);

    // Then get rid of that iframe
    iframe.remove();
  })();
}

// These are used to disable pointer events for iframes when
// dragging something that may move over an iframe.   See
// http://stackoverflow.com/questions/3627217/jquery-draggable-and-resizeable-over-iframes-solution
export function drag_start_iframe_disable(): void {
  $("iframe:visible").css("pointer-events", "none");
}

export function drag_stop_iframe_enable(): void {
  $("iframe:visible").css("pointer-events", "auto");
}
