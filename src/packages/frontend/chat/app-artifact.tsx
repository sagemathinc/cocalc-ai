/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An artifact that shows a project app live.  A shared browser (the one an
// agent and a human use together) is shown by CoCalc's own viewer, which
// connects to it over conat like a terminal; other apps through the
// project's authenticated app proxy.  Opening the card starts the app if it
// is not running, and the project too.

import { Alert, Button, Flex, Modal, Spin } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import {
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import type { ArtifactApp } from "@cocalc/chat";
import type { AppSpec } from "@cocalc/conat/project/api/apps";
import { getProjectAppOpenUrl } from "@cocalc/frontend/project/app-server-open";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  ensureSharedBrowserKey,
  forgetSharedBrowserSignIns,
} from "@cocalc/frontend/frame-editors/browser-editor/browser-key";
import {
  NoNetworkNotice,
  useProjectNetworkDisabled,
} from "@cocalc/frontend/frame-editors/browser-editor/no-network-notice";
import {
  BrowserStartScreen,
  type BrowserStartStep,
  loadBrowserPicture,
  saveBrowserPicture,
} from "@cocalc/frontend/frame-editors/browser-editor/start-screen";
import {
  type SharedBrowserControl,
  type SharedBrowserRemote,
  SharedBrowserViewer,
} from "@cocalc/frontend/frame-editors/browser-editor/viewer/viewer";
import { ensure_project_running } from "@cocalc/frontend/project/project-start-warning";
import {
  SHARED_BROWSER_APP_ID,
  sharedBrowserAppSpec,
} from "@cocalc/util/shared-browser";

export interface AppArtifactProps {
  projectId: string;
  app: ArtifactApp;
  title: string;
  // Identifies this place (an editor frame, a card) to the app, e.g. so the
  // shared browser shows each frame its own tab.
  view?: string;
  // Shown over the app, e.g. a panel the page draws for it.
  children?: ReactNode;
  // Shown above the app.
  notice?: ReactNode;
  // A shared browser: the page around it draws the "waiting for your
  // computer" panel; where it runs; asking an agent from its start page;
  // switching where it runs.
  hostPanel?: boolean;
  onRemote?: (remote: SharedBrowserRemote) => void;
  onAskAgent?: (text: string) => void;
  controlRef?: MutableRefObject<SharedBrowserControl | null>;
}

export function AppArtifact(props: AppArtifactProps) {
  return props.app.id.startsWith(SHARED_BROWSER_APP_ID) ? (
    <SharedBrowserArtifact {...props} />
  ) : (
    <ProjectAppFrame {...props} />
  );
}

// The apps known to run, by project and app id: showing one again (another
// tab or frame was in front) is instant, while it is checked meanwhile.
const RUNNING = new Map<string, { url?: string }>();

/**
 * Start the project and the app (unless the user shut it down), and say
 * what it is doing.
 */
function useRunningApp({
  projectId,
  app,
  title,
  isSharedBrowser,
  wantUrl,
}: {
  projectId: string;
  app: ArtifactApp;
  title: string;
  isSharedBrowser: boolean;
  wantUrl: boolean;
}) {
  const [running, setRunning] = useState<{ url?: string }>();
  const [step, setStep] = useState<BrowserStartStep>("browser");
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  // Shut down by the user.
  const [stopped, setStopped] = useState(false);
  const cacheKey = `${projectId}/${app.id}`;

  // Waking must be off while it is shut down: otherwise any open viewer
  // that reconnects starts it again.
  const setWake = async (enabled: boolean) => {
    const api = webapp_client.conat_client.projectApi({
      project_id: projectId,
    });
    const spec = (await api.apps.getAppSpec(app.id)) as AppSpec;
    if (spec.wake && spec.wake.enabled !== enabled)
      await api.apps.upsertAppSpec({
        ...spec,
        wake: { ...spec.wake, enabled },
      });
    return api;
  };
  const shutdown = async () => {
    const api = await setWake(false);
    await api.apps.stopApp(app.id);
    RUNNING.delete(cacheKey);
    setRunning(undefined);
    setStopped(true);
  };
  const start = async () => {
    await setWake(true);
    setStopped(false);
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    if (stopped) return;
    let canceled = false;
    const projectRunning =
      redux.getStore("projects")?.get_state?.(projectId) === "running";
    setRunning(projectRunning ? RUNNING.get(cacheKey) : undefined);
    setError(undefined);
    setStep(projectRunning ? "browser" : "project");
    void (async () => {
      // Like a terminal: opening it starts the project.
      if (!(await ensure_project_running(projectId, `use ${title}`)))
        throw Error("The project is not running. Start it to use this.");
      if (!canceled) setStep("browser");
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
      // Opening it after someone shut it down starts it again.
      if (spec.wake && spec.wake.enabled === false)
        spec = (
          await api.apps.upsertAppSpec({
            ...spec,
            wake: { ...spec.wake, enabled: true },
          })
        ).spec as AppSpec;
      // Before it starts: a browser keeps sign-ins only with the key.
      if (isSharedBrowser)
        await ensureSharedBrowserKey(projectId).catch((err) =>
          console.warn(`browser key: ${err?.message ?? err}`),
        );
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
      let url: string | undefined;
      if (wantUrl) {
        url =
          (await getProjectAppOpenUrl({
            getSpec: async () => spec,
            project_id: projectId,
            spec,
            status,
          })) ?? undefined;
        if (!url) throw Error(`The app "${app.id}" started but has no URL.`);
      }
      RUNNING.set(cacheKey, { url });
      if (!canceled) {
        setStep("connecting");
        setRunning({ url });
      }
    })().catch((err) => {
      if (!canceled) setError(`${err?.message ?? err}`);
    });
    return () => {
      canceled = true;
    };
  }, [projectId, app.id, attempt, cacheKey, stopped]);

  return {
    running,
    step,
    error,
    stopped,
    retry: () => setAttempt((n) => n + 1),
    shutdown,
    start: () => start().catch((err) => setError(`${err?.message ?? err}`)),
    setError,
  };
}

function Stopped({ title, onStart }: { title: string; onStart: () => void }) {
  return (
    <Flex
      align="center"
      justify="center"
      style={{ height: "100%", padding: 24 }}
    >
      <Alert
        type="info"
        showIcon
        title={`${title} is shut down`}
        action={
          <Button type="primary" style={{ marginLeft: 16 }} onClick={onStart}>
            Start
          </Button>
        }
      />
    </Flex>
  );
}

function Failed({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: string;
  onRetry: () => void;
}) {
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
          <Button style={{ marginLeft: 16 }} onClick={onRetry}>
            Retry
          </Button>
        }
      />
    </Flex>
  );
}

function SharedBrowserArtifact({
  projectId,
  app,
  title,
  view,
  children,
  notice,
  hostPanel,
  onRemote,
  onAskAgent,
  controlRef,
}: AppArtifactProps) {
  const run = useRunningApp({
    projectId,
    app,
    title,
    isSharedBrowser: true,
    wantUrl: false,
  });
  // The start screen, until the viewer shows the page.
  const [ready, setReady] = useState(false);
  const [picture, setPicture] = useState<string>();
  const pictureKey = `${projectId}/${app.id}/${view ?? ""}`;
  const networkDisabled = useProjectNetworkDisabled(projectId);
  useEffect(() => {
    let canceled = false;
    void loadBrowserPicture(pictureKey).then((p) => {
      if (!canceled && p) setPicture(p);
    });
    return () => {
      canceled = true;
    };
  }, [pictureKey]);
  useEffect(() => {
    if (!run.running) setReady(false);
  }, [run.running]);

  const name =
    app.id === SHARED_BROWSER_APP_ID
      ? "Web browser"
      : title.replace(/^Browser:\s*/, "");

  if (run.stopped) return <Stopped title={title} onStart={run.start} />;
  if (run.error)
    return <Failed title={title} error={run.error} onRetry={run.retry} />;
  if (!run.running)
    return (
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <BrowserStartScreen name={name} step={run.step} picture={picture} />
      </div>
    );
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {notice ?? (networkDisabled ? <NoNetworkNotice /> : null)}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <SharedBrowserViewer
          project_id={projectId}
          appId={app.id}
          view={view}
          hostPanel={hostPanel}
          controlRef={controlRef}
          onReady={() => setReady(true)}
          onPicture={(p) => void saveBrowserPicture(pictureKey, p)}
          onRemote={onRemote}
          onAskAgent={onAskAgent}
          onShutdown={() =>
            Modal.confirm({
              title: `Shut down ${title}?`,
              content:
                "It stops until someone starts it again; agents cannot use it meanwhile. It keeps its sign-ins.",
              okText: "Shut down",
              okButtonProps: { danger: true },
              onOk: () =>
                run
                  .shutdown()
                  .catch((err) => run.setError(`${err?.message ?? err}`)),
            })
          }
          onForget={() =>
            Modal.confirm({
              title: "Forget all sign-ins?",
              content:
                "Every web browser in this project starts over with an empty profile, signed out of all websites; open pages stay open. Cookies in old copies (snapshots, backups) can no longer be read, but sites' local storage in those copies can, and some sites keep sign-in tokens there. To end a session everywhere, sign out on the site itself.",
              okText: "Forget sign-ins",
              okButtonProps: { danger: true },
              onOk: () =>
                forgetSharedBrowserSignIns(projectId).catch((err) =>
                  run.setError(`${err?.message ?? err}`),
                ),
            })
          }
        />
        <StartScreenUntilReady
          name={name}
          picture={picture}
          ready={ready}
          onTimeout={() => setReady(true)}
        />
        {children}
      </div>
    </div>
  );
}

// Any other project app, through the project's authenticated app proxy.
function ProjectAppFrame({
  projectId,
  app,
  title,
  children,
  notice,
}: AppArtifactProps) {
  const run = useRunningApp({
    projectId,
    app,
    title,
    isSharedBrowser: false,
    wantUrl: true,
  });
  if (run.stopped) return <Stopped title={title} onStart={run.start} />;
  if (run.error)
    return <Failed title={title} error={run.error} onRetry={run.retry} />;
  if (!run.running?.url)
    return (
      <Flex align="center" justify="center" style={{ height: "100%" }}>
        <Spin tip={`Starting ${title}...`}>
          <div style={{ width: 200, height: 80 }} />
        </Spin>
      </Flex>
    );
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {notice}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <iframe
          src={run.running.url}
          title={title}
          style={{ border: 0, width: "100%", height: "100%", display: "block" }}
        />
        {children}
      </div>
    </div>
  );
}

// Over the viewer until it shows the page; then it fades out.
function StartScreenUntilReady({
  name,
  picture,
  ready,
  onTimeout,
}: {
  name: string;
  picture?: string;
  ready: boolean;
  onTimeout: () => void;
}) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!ready) {
      setGone(false);
      // Whatever happens, never hide a working browser for long.
      const timer = setTimeout(onTimeout, 30_000);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => setGone(true), 400);
    return () => clearTimeout(timer);
  }, [ready]);
  if (gone) return null;
  return (
    <BrowserStartScreen
      name={name}
      step="connecting"
      picture={picture}
      done={ready}
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
