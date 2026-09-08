/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Flex, Spin, Typography } from "antd";
import { useEffect, useState } from "react";
import type { AppSpec } from "@cocalc/conat/project/api/apps";
import { exec } from "@cocalc/frontend/frame-editors/generic/client";
import { getProjectAppOpenUrl } from "@cocalc/frontend/project/app-server-open";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  addBlitPassphrase,
  BLIT_APP_ID,
  CHECK_BLIT_PREREQUISITES,
  createBlitAppSpec,
  INSTALL_GRAPHICAL_APPS_COMMAND,
  parseBlitPrerequisites,
} from "./blit-app";
import { BlitLauncher } from "./blit-launcher";

interface Props {
  is_current: boolean;
  is_visible?: boolean;
  tab_is_visible?: boolean;
  project_id: string;
  reload?: number;
}

type Stage =
  | "checking"
  | "starting"
  | "stopped"
  | "stopping"
  | "installing"
  | "needs-packages"
  | "ready";

export function Blit({
  is_current,
  is_visible = true,
  tab_is_visible = true,
  project_id,
  reload,
}: Props) {
  const [stage, setStage] = useState<Stage>("checking");
  const [error, setError] = useState<string>();
  const [missingPackages, setMissingPackages] = useState<string[]>([]);
  const [src, setSrc] = useState<string>();
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let canceled = false;
    setStage("checking");
    setError(undefined);
    setMissingPackages([]);
    setSrc(undefined);
    void (async () => {
      const check = await exec({
        project_id,
        command: "bash",
        args: ["-lc", CHECK_BLIT_PREREQUISITES],
        timeout: 30,
        err_on_exit: false,
      });
      const prerequisites = parseBlitPrerequisites(
        `${check.stdout}\n${check.stderr}`,
      );
      if (prerequisites.missingTools.length) {
        throw new Error(
          `The project host is missing CoCalc graphical application tools: ${prerequisites.missingTools.join(
            ", ",
          )}. Restart the project and retry.`,
        );
      }
      if (prerequisites.missingPackages.length) {
        if (!canceled) {
          setMissingPackages(prerequisites.missingPackages);
          setStage("needs-packages");
        }
        return;
      }
      if (check.exit_code !== 0) {
        throw new Error(
          check.stderr || "Unable to check graphical application support.",
        );
      }
      if (!canceled) {
        setStage("starting");
      }
      const api = webapp_client.conat_client.projectApi({ project_id });
      const saved = await api.apps.upsertAppSpec(createBlitAppSpec(project_id));
      const spec = saved.spec as AppSpec;
      const status = await api.apps.ensureRunning(BLIT_APP_ID, {
        timeout: 60_000,
        interval: 500,
      });
      const url = await getProjectAppOpenUrl({
        getSpec: async () => spec,
        project_id,
        spec,
        status,
      });
      if (!url) {
        throw new Error("Blit started but CoCalc did not provide an app URL.");
      }
      if (!canceled) {
        setSrc(addBlitPassphrase(url, project_id));
        setStage("ready");
      }
    })().catch((err) => {
      if (!canceled) {
        setError(`${err}`);
      }
    });
    return () => {
      canceled = true;
    };
  }, [project_id, reload, retry]);

  async function installPackages(): Promise<void> {
    setStage("installing");
    setError(undefined);
    try {
      const result = await exec({
        project_id,
        command: "bash",
        args: ["-lc", INSTALL_GRAPHICAL_APPS_COMMAND],
        timeout: 20 * 60,
        err_on_exit: true,
      });
      if (result.exit_code !== 0) {
        throw new Error(
          result.stderr || "Graphical application support installation failed.",
        );
      }
      const api = webapp_client.conat_client.projectApi({ project_id });
      await api.apps.upsertAppSpec(createBlitAppSpec(project_id));
      await api.apps.stopApp(BLIT_APP_ID);
      setRetry((value) => value + 1);
    } catch (err) {
      setError(`${err}`);
      setStage("needs-packages");
    }
  }

  async function shutdown(): Promise<void> {
    const previousSrc = src;
    const api = webapp_client.conat_client.projectApi({ project_id });
    setStage("stopping");
    setSrc(undefined);
    try {
      await api.apps.upsertAppSpec(createBlitAppSpec(project_id, false));
      await api.apps.stopApp(BLIT_APP_ID);
      setStage("stopped");
    } catch (err) {
      await api.apps
        .upsertAppSpec(createBlitAppSpec(project_id))
        .catch(() => {});
      setSrc(previousSrc);
      setStage("ready");
      throw err;
    }
  }

  if (stage === "needs-packages" && !error) {
    return (
      <Flex
        align="center"
        justify="center"
        style={{ height: "100%", padding: 24 }}
      >
        <Alert
          action={
            <Button type="primary" onClick={installPackages}>
              Install graphical application support
            </Button>
          }
          description={
            <>
              <Typography.Paragraph>
                This project needs approximately 400 MB of Ubuntu packages for
                Xwayland, software rendering, and application audio.
                Installation modifies only this project&apos;s writable root
                filesystem.
              </Typography.Paragraph>
              <Typography.Text type="secondary">
                Missing: {missingPackages.join(", ")}
              </Typography.Text>
            </>
          }
          showIcon
          title="Graphical application support is not installed"
          type="warning"
        />
      </Flex>
    );
  }

  if (src) {
    // Hiding an iframe does not suspend its scripts or focus requests. Dispose
    // only the browser client; the managed compositor and applications keep
    // running, and the same URL reconnects when this frame becomes active.
    if (!is_current || !is_visible || !tab_is_visible) return null;
    return (
      <Flex
        style={{
          height: "100%",
          minHeight: 0,
          minWidth: 0,
          width: "100%",
        }}
        vertical
      >
        <BlitLauncher
          onShutdown={shutdown}
          project_id={project_id}
          shuttingDown={stage === "stopping"}
        />
        <iframe
          allow="autoplay; camera; clipboard-read; clipboard-write; fullscreen; microphone"
          aria-label="Blit graphical applications"
          key={src}
          src={src}
          style={{
            border: 0,
            flex: "1 1 auto",
            minHeight: 0,
            minWidth: 0,
            width: "100%",
          }}
          title="Blit graphical applications"
        />
      </Flex>
    );
  }

  if (stage === "stopped") {
    return (
      <Flex
        align="center"
        justify="center"
        style={{ height: "100%", padding: 24 }}
      >
        <Alert
          action={
            <Button
              type="primary"
              onClick={() => setRetry((value) => value + 1)}
            >
              Start graphical applications
            </Button>
          }
          description="All graphical windows and terminals in the shared project session were closed."
          showIcon
          title="Graphical applications are shut down"
          type="info"
        />
      </Flex>
    );
  }

  return (
    <Flex
      align="center"
      justify="center"
      style={{ height: "100%", padding: 24 }}
      vertical
    >
      {error ? (
        <Alert
          action={
            <Button onClick={() => setRetry((value) => value + 1)}>
              Retry
            </Button>
          }
          description={error}
          showIcon
          title="Unable to start graphical applications"
          type="error"
        />
      ) : (
        <Flex align="center" aria-live="polite" gap="middle" vertical>
          <Spin size="large" />
          <Typography.Text>
            {stage === "installing"
              ? "Installing graphical application support..."
              : stage === "stopping"
                ? "Shutting down graphical applications..."
                : stage === "checking"
                  ? "Checking graphical application support..."
                  : "Starting the Blit Wayland compositor..."}
          </Typography.Text>
        </Flex>
      )}
    </Flex>
  );
}
