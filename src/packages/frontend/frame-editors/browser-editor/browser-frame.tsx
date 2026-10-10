/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The browser of a .browser file: the shared browser viewer (the same one
// chat cards show), for a browser of this file's own, which keeps its
// profile.  Agents reach it with `cocalc project browser ... --browser <file>`.

import { Alert, Button, Flex, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { redux } from "@cocalc/frontend/app-framework";
import { resolveAssistantCodexModel } from "@cocalc/frontend/frame-editors/ai/create-chat";
import { ensure_project_running } from "@cocalc/frontend/project/project-start-warning";
import { BrowserStartScreen, type BrowserStartStep } from "./start-screen";
import { AppArtifact } from "@cocalc/frontend/chat/app-artifact";
import { CopyToClipBoard } from "@cocalc/frontend/components";
import { InstallCocalcCli } from "@cocalc/frontend/components/install-cocalc-cli";
import {
  NoNetworkNotice,
  useProjectNetworkDisabled,
} from "./no-network-notice";
import type { AppSpec } from "@cocalc/conat/project/api/apps";
import { resolveProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import type {
  SharedBrowserControl,
  SharedBrowserRemote,
} from "./viewer/viewer";
import {
  sharedBrowserAppSpec,
  sharedBrowserFileAppId,
  sharedBrowserTitle,
} from "@cocalc/util/shared-browser";

interface Props {
  id: string;
  project_id: string;
  path: string;
  reload?: number;
  actions?: any;
}

// Each frame (e.g. after a split) shows its own tab of the file's browser.
export function BrowserFrame({
  id: frameId,
  project_id,
  path,
  reload,
  actions,
}: Props) {
  const [app, setApp] = useState<{ id: string; title: string; file: string }>();
  // What the viewer reports: where the browser runs and whether it is there.
  const [remote, setRemote] = useState<SharedBrowserRemote>();
  const control = useRef<SharedBrowserControl | null>(null);
  const networkDisabled = useProjectNetworkDisabled(project_id);
  const tellViewer = (value: "project" | "computer") =>
    control.current?.setRunsOn(value);
  // The start page's "ask an agent": like the Agent button, in a new thread.
  const agentEnabled = !!redux
    .getStore("projects")
    ?.hasLanguageModelEnabled?.(project_id, "assistant");
  const askAgent = (text: string) => {
    if (!actions?.languageModel || !text.trim()) return;
    void actions
      .languageModel(
        frameId,
        {
          command: text.trim(),
          codegen: false,
          allowEmpty: true,
          model: resolveAssistantCodexModel(),
          tag: "custom",
          createNewThread: true,
          submitToAgent: true,
          frameType: "browser",
        },
        actions.languageModelGetContext?.(frameId) ?? "",
      )
      .catch((err) => setError(`${err?.message ?? err}`));
  };
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [step, setStep] = useState<BrowserStartStep>("browser");

  useEffect(() => {
    let canceled = false;
    setApp(undefined);
    setError(undefined);
    void (async () => {
      // Like a terminal: opening it starts the project.
      if (redux.getStore("projects")?.get_state?.(project_id) !== "running") {
        setStep("project");
        if (!(await ensure_project_running(project_id, "use this browser")))
          throw Error(
            "The project is not running. Start it to use this browser.",
          );
      }
      if (!canceled) setStep("browser");
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
      if (!canceled) setApp({ id, title: sharedBrowserTitle(file), file });
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
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <BrowserStartScreen name={path.split("/").pop() || path} step={step} />
      </div>
    );
  return (
    <div className="smc-vfill" style={{ minHeight: 0 }}>
      <AppArtifact
        key={`${app.id}:${reload ?? 0}`}
        projectId={project_id}
        app={{ id: app.id }}
        title={app.title}
        view={`frame:${frameId}`}
        // We draw the "waiting for your computer" panel (below).
        hostPanel
        onRemote={setRemote}
        controlRef={control}
        onAskAgent={agentEnabled ? askAgent : undefined}
        notice={
          // On the user's computer it uses their network.
          networkDisabled && remote?.runsOn !== "computer" ? (
            <NoNetworkNotice onRunOnComputer={() => tellViewer("computer")} />
          ) : (
            false
          )
        }
      >
        {remote?.runsOn === "computer" && remote.connection === "waiting" && (
          <WaitingForComputer
            command={connectCommand(project_id, app.file)}
            onRunInProject={() => tellViewer("project")}
          />
        )}
      </AppArtifact>
    </div>
  );
}

// What the user runs on their computer to connect this file's browser.
export function connectCommand(projectId: string, file: string): string {
  const quoted = /^[\w./~-]+$/.test(file)
    ? file
    : `'${file.replace(/'/g, "'\\''")}'`;
  return `cocalc project browser connect -w ${projectId} --browser ${quoted} --api ${window.location.origin}`;
}

function WaitingForComputer({
  command,
  onRunInProject,
}: {
  command: string;
  onRunInProject: () => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "auto",
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "40px 16px",
      }}
    >
      <div
        style={{
          background: "white",
          borderRadius: 8,
          padding: 20,
          maxWidth: 640,
          width: "100%",
          boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
        }}
      >
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          Waiting for your computer
        </Typography.Title>
        <Typography.Paragraph>
          This browser runs in Chrome on your computer, so sites see your
          network and your logins, and agents here can use it while it is
          connected.
        </Typography.Paragraph>
        <InstallCocalcCli title="1. Install the CoCalc CLI (once)" />
        <div style={{ marginTop: 16 }}>
          <Typography.Text strong>2. Run this on your computer</Typography.Text>
          <CopyToClipBoard
            value={command}
            inputWidth="100%"
            inputStyle={{ minWidth: 0 }}
            outerStyle={{ width: "100%" }}
            style={{ marginTop: 6, width: "100%" }}
          />
          <Typography.Paragraph type="secondary" style={{ marginTop: 6 }}>
            A Chrome window opens with this file's own profile and stays
            connected while the command runs. To sign in to a site that blocks
            automated browsers (e.g. X), add <code>--sign-in</code>: sign in,
            close the window, and it connects.
          </Typography.Paragraph>
        </div>
        <div style={{ textAlign: "right" }}>
          <Button onClick={onRunInProject}>
            Run it in the project instead
          </Button>
        </div>
      </div>
    </div>
  );
}
