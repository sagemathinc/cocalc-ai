/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An artifact that shows a project app live (e.g. the shared browser an
// agent and a human use together), through the project's authenticated app
// proxy.  Opening the card starts the app if it is not running.

import { Alert, Button, Flex, Spin } from "antd";
import { useEffect, useState } from "react";
import type { ArtifactApp } from "@cocalc/chat";
import type { AppSpec } from "@cocalc/conat/project/api/apps";
import { getProjectAppOpenUrl } from "@cocalc/frontend/project/app-server-open";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  SHARED_BROWSER_APP_ID,
  sharedBrowserAppSpec,
} from "@cocalc/util/shared-browser";

// The last open URL of each app, by project and app id.
const OPEN_URLS = new Map<string, string>();

export function AppArtifact({
  projectId,
  app,
  title,
  view,
}: {
  projectId: string;
  app: ArtifactApp;
  title: string;
  // Identifies this place (an editor frame, a card) to the app, e.g. so the
  // shared browser shows each frame its own tab.
  view?: string;
}) {
  const client = webapp_client.browser_id;
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  const cacheKey = `${projectId}/${app.id}`;
  useEffect(() => {
    let canceled = false;
    // Showing the app again (another tab or frame was in front) should be
    // instant: use the URL it had and check that it still runs meanwhile.
    const known = OPEN_URLS.get(cacheKey);
    setSrc(known && view ? withView(known, view, client) : known);
    setError(undefined);
    void (async () => {
      const api = webapp_client.conat_client.projectApi({
        project_id: projectId,
      });
      let spec: AppSpec;
      try {
        spec = await api.apps.getAppSpec(app.id);
      } catch {
        // The project's shared browser needs nothing but the CLI on the
        // project's PATH, so set it up rather than fail.
        if (app.id !== SHARED_BROWSER_APP_ID)
          throw Error(
            `The app "${app.id}" is not set up in this project (it may have been removed).`,
          );
        spec = (
          await api.apps.upsertAppSpec(
            sharedBrowserAppSpec({ exec: "cocalc", args: [] }) as AppSpec,
          )
        ).spec as AppSpec;
      }
      let status;
      try {
        status = await api.apps.ensureRunning(app.id, {
          timeout: 60_000,
          interval: 500,
        });
      } catch (err) {
        // A bare "timeout" says nothing: show why the app is not running.
        const detail = await appFailureDetail(api, app.id);
        throw Error(detail ? `${err}\n\n${detail}` : `${err}`);
      }
      const url = await getProjectAppOpenUrl({
        getSpec: async () => spec,
        project_id: projectId,
        spec,
        status,
      });
      if (!url) throw Error(`The app "${app.id}" started but has no URL.`);
      OPEN_URLS.set(cacheKey, url);
      if (!canceled) setSrc(view ? withView(url, view, client) : url);
    })().catch((err) => {
      if (!canceled) setError(`${err?.message ?? err}`);
    });
    return () => {
      canceled = true;
    };
  }, [projectId, app.id, attempt, view, cacheKey]);

  if (error)
    return (
      <Flex
        align="center"
        justify="center"
        style={{ height: "100%", padding: 24 }}
      >
        <Alert
          type="warning"
          showIcon
          title={`Could not open ${title}`}
          description={<div style={{ whiteSpace: "pre-wrap" }}>{error}</div>}
          action={
            <Button
              style={{ marginLeft: 16 }}
              onClick={() => setAttempt((n) => n + 1)}
            >
              Retry
            </Button>
          }
        />
      </Flex>
    );
  if (!src)
    return (
      <Flex align="center" justify="center" style={{ height: "100%" }}>
        <Spin tip={`Starting ${title}...`}>
          <div style={{ width: 200, height: 80 }} />
        </Spin>
      </Flex>
    );
  return (
    <iframe
      src={src}
      title={title}
      // The app is the project's own code behind CoCalc's app proxy.
      allow="clipboard-read; clipboard-write"
      style={{ border: 0, width: "100%", height: "100%", display: "block" }}
    />
  );
}

// The end of what a failed app wrote to stderr, e.g. why its browser exited.
async function appFailureDetail(api, id: string): Promise<string> {
  try {
    const status = await api.apps.statusApp(id);
    const stderr = `${status?.stderr ?? ""}`.trim();
    return stderr.length > 600 ? `...${stderr.slice(-600)}` : stderr;
  } catch {
    return "";
  }
}

function withView(url: string, view: string, client: string): string {
  const [base, hash] = url.split("#", 2);
  const sep = base.includes("?") ? "&" : "?";
  const query = `view=${encodeURIComponent(view)}&client=${encodeURIComponent(client)}`;
  return `${base}${sep}${query}${hash ? `#${hash}` : ""}`;
}
