/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An artifact that shows a project app live (e.g. the shared browser an
// agent and a human use together), through the project's authenticated app
// proxy.  Opening the card starts the app if it is not running.

import { Alert, Button, Flex, Modal, Spin } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import {
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
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
import { ensure_project_running } from "@cocalc/frontend/project/project-start-warning";
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
  params,
  onMessage,
  frameRef,
  children,
  notice,
}: {
  projectId: string;
  app: ArtifactApp;
  title: string;
  // Identifies this place (an editor frame, a card) to the app, e.g. so the
  // shared browser shows each frame its own tab.
  view?: string;
  // More query parameters for the app.
  params?: Record<string, string>;
  // Messages the app posts to this page (from its own iframe only).
  onMessage?: (data: any) => void;
  frameRef?: MutableRefObject<HTMLIFrameElement | null>;
  // Shown over the app, e.g. a panel the page draws for it.
  children?: ReactNode;
  // Shown above the app.
  notice?: ReactNode;
}) {
  const isSharedBrowser = app.id.startsWith(SHARED_BROWSER_APP_ID);
  // A browser's start screen, until the viewer shows the page.
  const [step, setStep] = useState<BrowserStartStep>("browser");
  const [ready, setReady] = useState(false);
  const [picture, setPicture] = useState<string>();
  const stateSeen = useRef(false);
  const pictureKey = `${projectId}/${app.id}/${view ?? ""}`;
  useEffect(() => {
    if (!isSharedBrowser) return;
    let canceled = false;
    void loadBrowserPicture(pictureKey).then((p) => {
      if (!canceled && p) setPicture(p);
    });
    return () => {
      canceled = true;
    };
  }, [pictureKey, isSharedBrowser]);
  const client = webapp_client.browser_id;
  const networkDisabled = useProjectNetworkDisabled(projectId);
  const ownFrame = useRef<HTMLIFrameElement | null>(null);
  const iframe = frameRef ?? ownFrame;
  const query = useMemo(
    () => ({
      ...(view ? { view, client } : {}),
      // The site the user is on: e.g. for commands to run against it.
      site: window.location.origin,
      ...(params ?? {}),
    }),
    [view, client, JSON.stringify(params ?? {})],
  );
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  // Shut down by the user (the app's own "shut down" button).
  const [stopped, setStopped] = useState(false);

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
    setSrc(undefined);
    setStopped(true);
  };
  const start = async () => {
    await setWake(true);
    setStopped(false);
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (!event.source || event.source !== iframe.current?.contentWindow)
        return;
      if (event.data?.type === "cocalc-app-shutdown") {
        Modal.confirm({
          title: `Shut down ${title}?`,
          content:
            "It stops until someone starts it again; agents cannot use it meanwhile. It keeps its sign-ins.",
          okText: "Shut down",
          okButtonProps: { danger: true },
          onOk: () =>
            shutdown().catch((err) => setError(`${err?.message ?? err}`)),
        });
        return;
      }
      if (event.data?.type === "cocalc-browser-ready") {
        setReady(true);
        return;
      }
      if (event.data?.type === "cocalc-browser-picture") {
        if (typeof event.data.picture === "string")
          void saveBrowserPicture(pictureKey, event.data.picture);
        return;
      }
      if (event.data?.type === "cocalc-browser-state" && !stateSeen.current) {
        // A viewer from before "ready" (its project has older tools).
        stateSeen.current = true;
        setTimeout(() => setReady(true), 4000);
      }
      if (event.data?.type === "cocalc-browser-forget") {
        Modal.confirm({
          title: "Forget all sign-ins?",
          content:
            "Every web browser in this project is signed out of all websites, and the sign-ins in copies of them (snapshots, backups) can no longer be read. Open pages stay open. Agents and you sign in again as needed.",
          okText: "Forget sign-ins",
          okButtonProps: { danger: true },
          onOk: () =>
            forgetSharedBrowserSignIns(projectId).catch((err) =>
              setError(`${err?.message ?? err}`),
            ),
        });
        return;
      }
      onMessage?.(event.data);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onMessage, iframe, title, projectId, app.id, pictureKey]);

  const cacheKey = `${projectId}/${app.id}`;
  useEffect(() => {
    if (stopped) return;
    let canceled = false;
    const projectRunning =
      redux.getStore("projects")?.get_state?.(projectId) === "running";
    // Showing the app again (another tab or frame was in front) should be
    // instant: use the URL it had and check that it still runs meanwhile.
    const known = projectRunning ? OPEN_URLS.get(cacheKey) : undefined;
    setSrc(known ? withQuery(known, query) : known);
    setError(undefined);
    setReady(false);
    stateSeen.current = false;
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
      const url = await getProjectAppOpenUrl({
        getSpec: async () => spec,
        project_id: projectId,
        spec,
        status,
      });
      if (!url) throw Error(`The app "${app.id}" started but has no URL.`);
      OPEN_URLS.set(cacheKey, url);
      if (!canceled) {
        setStep("connecting");
        setSrc(withQuery(url, query));
      }
    })().catch((err) => {
      if (!canceled) setError(`${err?.message ?? err}`);
    });
    return () => {
      canceled = true;
    };
  }, [projectId, app.id, attempt, query, cacheKey, stopped]);

  if (stopped)
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
            <Button
              type="primary"
              style={{ marginLeft: 16 }}
              onClick={() =>
                start().catch((err) => setError(`${err?.message ?? err}`))
              }
            >
              Start
            </Button>
          }
        />
      </Flex>
    );
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
  const name =
    app.id === SHARED_BROWSER_APP_ID
      ? "Web browser"
      : title.replace(/^Browser:\s*/, "");
  if (!src && isSharedBrowser)
    return (
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <BrowserStartScreen name={name} step={step} picture={picture} />
      </div>
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
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {notice ??
        (networkDisabled && isSharedBrowser ? (
          <NoNetworkNotice />
        ) : null)}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <iframe
          ref={iframe}
          src={src}
          title={title}
          // The app is the project's own code behind CoCalc's app proxy.
          allow="clipboard-read; clipboard-write"
          style={{ border: 0, width: "100%", height: "100%", display: "block" }}
        />
        {isSharedBrowser ? (
          <StartScreenUntilReady
            name={name}
            picture={picture}
            ready={ready}
            onTimeout={() => setReady(true)}
          />
        ) : null}
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

function withQuery(url: string, query: Record<string, string>): string {
  const [base, hash] = url.split("#", 2);
  const text = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  if (!text) return url;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${text}${hash ? `#${hash}` : ""}`;
}
