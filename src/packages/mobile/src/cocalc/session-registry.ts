/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { openSiteSession, type SiteSession } from "./site-session";

let activeProfileId: string | undefined;
let activeSession: SiteSession | undefined;
let activePromise: Promise<SiteSession> | undefined;

export async function getActiveSiteSession(
  profileId: string,
): Promise<SiteSession> {
  if (activeProfileId === profileId && activeSession) return activeSession;
  if (activeProfileId === profileId && activePromise)
    return await activePromise;
  closeActiveSiteSession();
  activeProfileId = profileId;
  const promise = openSiteSession(profileId)
    .then((session) => {
      if (activeProfileId !== profileId) {
        session.close();
        throw new Error("The active CoCalc profile changed while connecting.");
      }
      activeSession = session;
      return session;
    })
    .finally(() => {
      if (activePromise === promise) activePromise = undefined;
    });
  activePromise = promise;
  return await promise;
}

export function peekActiveSiteSession(): SiteSession | undefined {
  return activeSession;
}

export function closeActiveSiteSession(): void {
  activeSession?.close();
  activeSession = undefined;
  activePromise = undefined;
  activeProfileId = undefined;
}
