/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Site icons for tabs and the start page.  An icon in the page itself (a
// data: URL) is used as it is; others are fetched by the browser service
// (public sites only) and kept here as blob URLs.

import { useEffect, useState } from "react";

import type { SharedBrowserConnection } from "./connection";

const MAX_ICONS = 300;
const icons = new Map<string, Promise<string | null>>();

export function iconUrl(
  connection: SharedBrowserConnection,
  url: string,
): Promise<string | null> {
  if (/^data:image\//i.test(url)) return Promise.resolve(url);
  if (!/^https?:\/\//i.test(url)) return Promise.resolve(null);
  const known = icons.get(url);
  if (known) return known;
  const loading = connection
    .favicon(url)
    .then((icon) =>
      icon
        ? URL.createObjectURL(
            new Blob([icon.body as BlobPart], { type: icon.type }),
          )
        : null,
    )
    .catch(() => {
      // Not connected, say: ask again next time.
      icons.delete(url);
      return null;
    });
  icons.set(url, loading);
  while (icons.size > MAX_ICONS) {
    const [oldest, value] = icons.entries().next().value!;
    icons.delete(oldest);
    void value.then(
      (blob) => blob?.startsWith("blob:") && URL.revokeObjectURL(blob),
    );
  }
  return loading;
}

export function useIcon(
  connection: SharedBrowserConnection | null,
  url: string | undefined,
): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!connection || !url) return;
    let canceled = false;
    void iconUrl(connection, url).then((value) => {
      if (!canceled) setSrc(value);
    });
    return () => {
      canceled = true;
    };
  }, [connection, url]);
  return src;
}
