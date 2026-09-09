/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** Legacy URLs must still serve PostgreSQL-only images during the backfill. */
export async function isPublicBlobAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    return (
      response.status === 200 &&
      response.headers.get("content-type")?.startsWith("image/") === true
    );
  } catch {
    return false;
  }
}
