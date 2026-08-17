/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { lazy, Suspense, useEffect, useState } from "react";
import { getAuthBootstrap, type AuthBootstrap } from "./api";
import {
  ESSENTIAL_ROUTE_CHANGE,
  essentialRouteUrl,
  parseRoute,
  type UltraliteRoute,
} from "./routes";
import { EssentialThemeProvider } from "./theme-context";
import { FrontendUpdateNotice } from "./frontend-update";
import { siteUrl } from "./urls";
import { ShellLoading, TopBar } from "./ui";
import {
  markUltraliteBackend,
  markUltralitePhase,
  recordUltraliteOutcome,
  recordUltraliteSurfaceReady,
} from "./telemetry";

function loadWorkspace() {
  return new Promise<typeof import("./workspace")>((resolve, reject) => {
    // The static package compiles to CommonJS, so native import() would be
    // rewritten to require(). Keep this explicit Rspack split point.
    require.ensure(
      [],
      () => resolve(require("./workspace")),
      reject,
      "ultralite-workspace",
    );
  });
}

function loadChatSurface() {
  return new Promise<typeof import("./chat-surface")>((resolve, reject) => {
    require.ensure(
      [],
      () => resolve(require("./chat-surface")),
      reject,
      "ultralite-chat",
    );
  });
}

const Workspace = lazy(loadWorkspace);
const ProjectsWorkspace = lazy(
  () =>
    new Promise((resolve, reject) => {
      require.ensure(
        [],
        () => resolve(require("./projects-workspace")),
        reject,
        "ultralite-projects",
      );
    }),
);
const NotificationsSurface = lazy(
  () =>
    new Promise((resolve, reject) => {
      require.ensure(
        [],
        () => resolve(require("./notifications-surface")),
        reject,
        "ultralite-notifications",
      );
    }),
);

export function UltraliteApp() {
  const [bootstrap, setBootstrap] = useState<AuthBootstrap>();
  const [error, setError] = useState<string>();
  const [route, setRoute] = useState<UltraliteRoute>(() => parseRoute());
  const [projectTitle, setProjectTitle] = useState<string>();
  const routeProjectId = "projectId" in route ? route.projectId : undefined;
  const projectRoute = routeProjectId != null;

  useEffect(() => {
    if (!projectRoute) return;
    const loads: Promise<unknown>[] = [loadWorkspace()];
    if (route.kind === "chat" || route.kind === "agents") {
      markUltralitePhase("chat", "route-chunks", "start");
      loads.push(loadChatSurface());
    }
    void Promise.all(loads)
      .then(() => {
        if (route.kind === "chat" || route.kind === "agents") {
          markUltralitePhase("chat", "route-chunks", "end");
        }
      })
      .catch(() => undefined);
  }, [projectRoute, route.kind]);

  useEffect(() => {
    const controller = new AbortController();
    markUltraliteBackend("shell", "start");
    void getAuthBootstrap(controller.signal)
      .then((value) => {
        markUltraliteBackend("shell", "end");
        setBootstrap(value);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          markUltraliteBackend("shell", "end");
          recordUltraliteOutcome("shell", "auth_failure");
          setError(err instanceof Error ? err.message : `${err}`);
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!projectRoute) {
      setProjectTitle(undefined);
      return;
    }
    const project = bootstrap?.project_window?.find(
      ({ project_id }) => project_id === routeProjectId,
    );
    setProjectTitle(project?.title || undefined);
  }, [bootstrap?.project_window, projectRoute, routeProjectId]);

  useEffect(() => {
    const title = projectRoute
      ? projectTitle || "Project"
      : route.kind === "notifications"
        ? "Notifications"
        : "Projects";
    document.title = `${title} - CoCalc`;
  }, [projectRoute, projectTitle, route.kind]);

  useEffect(() => {
    if (bootstrap?.signed_in) recordUltraliteSurfaceReady("shell");
  }, [bootstrap?.signed_in]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.(
        "a[data-ul-full-cocalc]",
      );
      if (anchor) {
        recordUltraliteOutcome("shell", "full_cocalc");
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    const onRouteChange = () => setRoute(parseRoute());
    const initialRoute = parseRoute();
    const canonicalUrl = essentialRouteUrl(initialRoute);
    if (
      `${window.location.pathname}${window.location.search}` !== canonicalUrl ||
      window.location.hash
    ) {
      window.history.replaceState({}, "", canonicalUrl);
    }
    setRoute(initialRoute);
    window.addEventListener("popstate", onRouteChange);
    window.addEventListener(ESSENTIAL_ROUTE_CHANGE, onRouteChange);
    return () => {
      window.removeEventListener("popstate", onRouteChange);
      window.removeEventListener(ESSENTIAL_ROUTE_CHANGE, onRouteChange);
    };
  }, []);

  return (
    <EssentialThemeProvider>
      <a className="ul-skip" href="#main-content">
        Skip to content
      </a>
      {bootstrap?.signed_in ? <FrontendUpdateNotice /> : null}
      <TopBar
        projectTitle={projectRoute ? projectTitle || "Project" : undefined}
      />
      {error ? (
        <main className="ul-centered" id="main-content">
          <h1>Essential CoCalc could not start</h1>
          <p className="ul-error" role="alert">
            {error}
          </p>
          <button
            className="ul-button"
            onClick={() => window.location.reload()}
            type="button"
          >
            Try again
          </button>
        </main>
      ) : bootstrap == null ? (
        <ShellLoading />
      ) : !bootstrap.signed_in ||
        !bootstrap.account_id ||
        !bootstrap.home_bay_url ? (
        <main className="ul-centered" id="main-content">
          <h1>Sign in to continue</h1>
          <p>
            Essential CoCalc uses your existing account and project permissions.
          </p>
          <a
            className="ul-link-button"
            data-ul-full-cocalc
            href={siteUrl("app")}
          >
            Open CoCalc to sign in
          </a>
        </main>
      ) : (
        <Suspense fallback={<ShellLoading />}>
          {route.kind === "projects" ? (
            <ProjectsWorkspace bootstrap={bootstrap} />
          ) : route.kind === "notifications" ? (
            <NotificationsSurface bootstrap={bootstrap} />
          ) : (
            <Workspace
              bootstrap={bootstrap}
              onProjectTitleChange={setProjectTitle}
              route={route}
            />
          )}
        </Suspense>
      )}
    </EssentialThemeProvider>
  );
}
