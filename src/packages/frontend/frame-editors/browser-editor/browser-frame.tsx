/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The browser of a .browser file: the shared browser viewer (the same one
// chat cards show), for a browser of this file's own, which keeps its
// profile.  Agents reach it with `cocalc project browser ... --browser <file>`.

import { Alert, Button, Flex, Spin } from "antd";
import { useEffect, useState } from "react";
import { AppArtifact } from "@cocalc/frontend/chat/app-artifact";
import type { AppSpec } from "@cocalc/conat/project/api/apps";
import { resolveProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import {
  sharedBrowserAppSpec,
  sharedBrowserFileAppId,
  sharedBrowserTitle,
} from "@cocalc/util/shared-browser";

interface Props {
  project_id: string;
  path: string;
  reload?: number;
}

export function BrowserFrame({ project_id, path, reload }: Props) {
  const [app, setApp] = useState<{ id: string; title: string }>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let canceled = false;
    setApp(undefined);
    setError(undefined);
    void (async () => {
      const file = normalizeAbsolutePath(
        path,
        await resolveProjectHomeDirectory(project_id),
      );
      const id = sharedBrowserFileAppId(file);
      // `serve` runs the CLI on the project's PATH and needs no credentials.
      const api = webapp_client.conat_client.projectApi({ project_id });
      await api.apps.upsertAppSpec(
        sharedBrowserAppSpec({
          exec: "cocalc",
          args: [],
          appId: id,
          file,
        }) as AppSpec,
      );
      if (!canceled) setApp({ id, title: sharedBrowserTitle(file) });
    })().catch((err) => {
      if (!canceled) setError(`${err?.message ?? err}`);
    });
    return () => {
      canceled = true;
    };
  }, [project_id, path, attempt]);

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
          title="Could not set up this browser"
          description={error}
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
  if (!app)
    return (
      <Flex align="center" justify="center" style={{ height: "100%" }}>
        <Spin />
      </Flex>
    );
  return (
    <div className="smc-vfill" style={{ minHeight: 0 }}>
      <AppArtifact
        key={`${app.id}:${reload ?? 0}`}
        projectId={project_id}
        app={{ id: app.id }}
        title={app.title}
      />
    </div>
  );
}
