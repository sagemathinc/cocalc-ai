/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import { useEffect, useState } from "react";
import type { UltraliteSession } from "./session";
import { InlineAlert, LoadingState, SurfaceHeader } from "./ui";
import { siteUrl } from "./urls";

export default function SettingsSurface({
  project,
  session,
}: {
  project: AccountProjectListWindowRow;
  session: UltraliteSession;
}) {
  const [state, setState] = useState<string>(
    `${project.state_summary?.state ?? "unknown"}`,
  );
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = async () => {
    const current = await session.getProjectState(project.project_id);
    if (current.error) throw new Error(current.error);
    setState(current.state || "unknown");
  };

  useEffect(() => {
    let active = true;
    void session
      .getProjectState(project.project_id)
      .then((current) => {
        if (!active) return;
        if (current.error) throw new Error(current.error);
        setState(current.state || "unknown");
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : `${err}`);
      });
    return () => {
      active = false;
    };
  }, [project.project_id, session]);

  const run = async (operation: "start" | "stop" | "restart") => {
    if (busy) return;
    if (
      operation !== "start" &&
      !window.confirm(
        `${operation === "stop" ? "Stop" : "Restart"} this project? Active terminals, notebooks, and processes will be interrupted.`,
      )
    ) {
      return;
    }
    setBusy(operation);
    setError(undefined);
    try {
      if (operation === "start") {
        await session.ensureProjectRunning(project.project_id, setState);
      } else if (operation === "stop") {
        await session.hubApi.projects.stop({ project_id: project.project_id });
      } else {
        await session.hubApi.projects.restart({
          project_id: project.project_id,
          wait: true,
        });
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setBusy(undefined);
    }
  };

  const running = state === "running";
  return (
    <main className="ul-page" id="main-content">
      <SurfaceHeader
        actions={
          <a
            className="ul-link-button ul-link-button-subtle"
            data-ul-full-cocalc
            href={siteUrl(`projects/${project.project_id}/settings`)}
          >
            Full project settings
          </a>
        }
        eyebrow="Essential controls"
        title="Project settings"
      />
      <div className="ul-context-list">
        <div>
          <strong>Title</strong>
          <span>{project.title || "Untitled project"}</span>
        </div>
        {project.description ? (
          <div>
            <strong>Description</strong>
            <span>{project.description}</span>
          </div>
        ) : null}
        <div>
          <strong>State</strong>
          <span className={running ? "ul-status-running" : undefined}>
            {state}
          </span>
        </div>
        <div>
          <strong>Project ID</strong>
          <code>{project.project_id}</code>
        </div>
        <div>
          <strong>Project host</strong>
          <code>{project.host_id ?? "not assigned"}</code>
        </div>
      </div>
      {error ? <InlineAlert kind="error">{error}</InlineAlert> : null}
      {busy ? <LoadingState label={`${busy} in progress`} /> : null}
      <div className="ul-toolbar">
        {!running ? (
          <button
            className="ul-button"
            disabled={!!busy}
            onClick={() => void run("start")}
            type="button"
          >
            Start project
          </button>
        ) : (
          <>
            <button
              className="ul-button ul-button-secondary"
              disabled={!!busy}
              onClick={() => void run("restart")}
              type="button"
            >
              Restart project
            </button>
            <button
              className="ul-button ul-button-danger"
              disabled={!!busy}
              onClick={() => void run("stop")}
              type="button"
            >
              Stop project
            </button>
          </>
        )}
        <button
          className="ul-icon-button"
          disabled={!!busy}
          onClick={() => void refresh().catch((err) => setError(`${err}`))}
          type="button"
        >
          Refresh state
        </button>
      </div>
      <p className="ul-muted">
        Essential CoCalc intentionally limits this page to project identity and
        lifecycle. Collaborators, resources, images, backups, and advanced
        configuration remain in full project settings.
      </p>
    </main>
  );
}
