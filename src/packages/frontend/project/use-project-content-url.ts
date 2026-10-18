/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A link to a project file on the project's content origin (trust-free
// step 6): a separate site with no access to the user's CoCalc session, so
// the file's HTML, scripts and relative images can run safely.  The link is
// re-issued before it expires.

import { useEffect, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export type ProjectContentUrlState =
  | { status: "loading" }
  // The content origin can't serve this project: use the old behavior.
  | { status: "unavailable" }
  | { status: "ready"; url: string };

// Don't ask again for a while once a project's content origin is off.
const UNAVAILABLE_RETRY_MS = 5 * 60 * 1000;
const unavailableUntil = new Map<string, number>();

// When to re-issue a link: an hour before it expires, or halfway for a
// short one.
export function refreshDelayMs(expires_at: number, now = Date.now()): number {
  const left = Math.max(0, expires_at - now);
  return Math.max(30_000, left - Math.min(60 * 60 * 1000, left / 2));
}

export function useProjectContentUrl({
  project_id,
  path,
  enabled = true,
}: {
  project_id: string;
  path: string;
  enabled?: boolean;
}): ProjectContentUrlState {
  const [state, setState] = useState<ProjectContentUrlState>({
    status: "loading",
  });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    setState({ status: "loading" });
  }, [project_id, path]);

  useEffect(() => {
    if (!enabled || (unavailableUntil.get(project_id) ?? 0) > Date.now()) {
      setState({ status: "unavailable" });
      return;
    }
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        // Makes sure the host knows this account is a member.
        await webapp_client.conat_client.ensureProjectHostBrowserSessionForProject(
          { project_id },
        );
        const result =
          await webapp_client.conat_client.hub.hosts.issueProjectContentUrl({
            project_id,
            path,
          });
        if (canceled) return;
        if (!("url" in result)) {
          unavailableUntil.set(project_id, Date.now() + UNAVAILABLE_RETRY_MS);
          setState({ status: "unavailable" });
          return;
        }
        setState((prev) =>
          prev.status === "ready" && prev.url === result.url
            ? prev
            : { status: "ready", url: result.url },
        );
        timer = setTimeout(
          () => setGeneration((n) => n + 1),
          refreshDelayMs(result.expires_at),
        );
      } catch {
        // An error (for example a viewer, or an old hub) falls back too.
        if (!canceled) setState({ status: "unavailable" });
      }
    })();
    return () => {
      canceled = true;
      if (timer != null) clearTimeout(timer);
    };
  }, [project_id, path, enabled, generation]);

  return state;
}
