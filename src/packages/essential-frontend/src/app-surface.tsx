/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { NamedServerStatus } from "@cocalc/conat/project/api/apps";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import { useEffect, useState } from "react";
import type { UltraliteSession } from "./session";
import { fullProjectToolUrl } from "./urls";
import { InlineAlert, LoadingState, SurfaceHeader } from "./ui";
import { UltraliteIcon } from "./icons";
import {
  markUltraliteBackend,
  recordUltraliteFailure,
  recordUltraliteSurfaceReady,
} from "./telemetry";

const SERVERS = [
  {
    description: "The full JupyterLab interface served by this project.",
    label: "JupyterLab",
    name: "jupyterlab",
  },
  {
    description: "Visual Studio Code running in the project.",
    label: "VS Code",
    name: "code",
  },
] as const;

type ServerName = (typeof SERVERS)[number]["name"];

export default function AppSurface({
  project,
  session,
}: {
  project: AccountProjectListWindowRow;
  session: UltraliteSession;
}) {
  const [statuses, setStatuses] = useState<
    Partial<Record<ServerName, NamedServerStatus>>
  >({});
  const [projectRunning, setProjectRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ServerName>();
  const [error, setError] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    markUltraliteBackend("apps", "start");
    try {
      const state = await session.getProjectState(project.project_id);
      const running = state.state === "running";
      setProjectRunning(running);
      if (!running) {
        setStatuses({});
        markUltraliteBackend("apps", "end");
        recordUltraliteSurfaceReady("apps");
        return;
      }
      const { api } = await session.openProjectApi(
        project.project_id,
        project.host_id!,
      );
      const values = await Promise.all(
        SERVERS.map(
          async ({ name }) => [name, await api.apps.status(name)] as const,
        ),
      );
      setStatuses(Object.fromEntries(values));
      markUltraliteBackend("apps", "end");
      recordUltraliteSurfaceReady("apps");
    } catch (err) {
      markUltraliteBackend("apps", "end");
      recordUltraliteFailure("apps", err);
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // App status is an explicit route read, not a permanent poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.project_id, session]);

  const start = async (name: ServerName) => {
    if (busy) return;
    setBusy(name);
    setError(undefined);
    try {
      await session.ensureProjectRunning(project.project_id);
      setProjectRunning(true);
      const { api } = await session.openProjectApi(
        project.project_id,
        project.host_id!,
      );
      const starting = await api.apps.start(name);
      setStatuses((current) => ({
        ...current,
        [name]: starting,
      }));
      await api.apps.waitForState(name, "running", {
        interval: 1000,
        timeout: 120_000,
      });
      const ready = await api.apps.status(name);
      setStatuses((current) => ({
        ...current,
        [name]: ready,
      }));
    } catch (err) {
      recordUltraliteFailure("apps", err);
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setBusy(undefined);
    }
  };

  const stop = async (name: ServerName) => {
    if (busy) return;
    setBusy(name);
    setError(undefined);
    try {
      const { api } = await session.openProjectApi(
        project.project_id,
        project.host_id!,
      );
      await api.apps.stop(name);
      setStatuses((current) => ({
        ...current,
        [name]: { state: "stopped" },
      }));
    } catch (err) {
      recordUltraliteFailure("apps", err);
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setBusy(undefined);
    }
  };

  const open = async (name: ServerName) => {
    const status = statuses[name];
    if (!status?.url) return;
    setBusy(name);
    setError(undefined);
    try {
      const url = await session.prepareProjectHttpUrl({
        host_id: project.host_id!,
        project_id: project.project_id,
        url: status.url,
      });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      recordUltraliteFailure("apps", err);
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <main className="ul-page" id="main-content">
      <SurfaceHeader
        actions={
          <>
            <button
              className="ul-icon-button"
              onClick={() => void load()}
              type="button"
            >
              <UltraliteIcon name="refresh" /> Refresh
            </button>
            <a
              className="ul-link-button ul-link-button-subtle"
              data-ul-full-cocalc
              href={fullProjectToolUrl({
                projectId: project.project_id,
                tool: "servers",
              })}
            >
              All app servers
            </a>
          </>
        }
        eyebrow="Project services"
        title="Apps"
      />
      {!projectRunning && !loading ? (
        <InlineAlert kind="info">
          This project is stopped. Starting an app will explicitly start project
          compute; merely viewing this page does not.
        </InlineAlert>
      ) : null}
      {error ? <InlineAlert kind="error">{error}</InlineAlert> : null}
      {loading ? <LoadingState label="Checking project app servers" /> : null}
      <div className="ul-compact-list">
        {SERVERS.map(({ description, label, name }) => {
          const status = statuses[name];
          const running = status?.state === "running";
          const ready = running && status.ready === true && !!status.url;
          return (
            <div className="ul-compact-row" key={name}>
              <div className="ul-row-grid">
                <div>
                  <div className="ul-row-title">{label}</div>
                  <div className="ul-row-detail">{description}</div>
                  <div className="ul-row-detail">
                    {status?.state ??
                      (projectRunning ? "stopped" : "project stopped")}
                    {running && !ready ? " · starting" : ""}
                  </div>
                </div>
                <div className="ul-toolbar">
                  {ready ? (
                    <button
                      className="ul-button"
                      disabled={busy === name}
                      onClick={() => void open(name)}
                      type="button"
                    >
                      Open
                    </button>
                  ) : (
                    <button
                      className="ul-button"
                      disabled={busy != null}
                      onClick={() => void start(name)}
                      type="button"
                    >
                      {busy === name ? "Starting..." : "Start"}
                    </button>
                  )}
                  {running ? (
                    <button
                      className="ul-button ul-button-secondary"
                      disabled={busy != null}
                      onClick={() => {
                        if (window.confirm(`Stop ${label}?`)) void stop(name);
                      }}
                      type="button"
                    >
                      Stop
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
