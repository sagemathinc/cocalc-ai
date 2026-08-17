/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import { useEffect, useRef, useState } from "react";
import { getAccountProjectWindow, type AuthBootstrap } from "./api";
import { navigate } from "./routes";
import {
  markUltraliteBackend,
  recordUltraliteFailure,
  recordUltraliteSurfaceReady,
} from "./telemetry";
import { EmptyState, InlineAlert, LoadingState, SurfaceHeader } from "./ui";

const PAGE_SIZE = 50;

function stateLabel(project: AccountProjectListWindowRow): string {
  const state = `${project.state_summary?.state ?? "off"}`;
  return state === "running" ? "running" : state;
}

export default function ProjectsWorkspace({
  bootstrap,
}: {
  bootstrap: AuthBootstrap;
}) {
  const [projects, setProjects] = useState(
    () => bootstrap.project_window ?? [],
  );
  const [hasMore, setHasMore] = useState(
    bootstrap.project_window_has_more === true,
  );
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const firstQuery = useRef(true);

  useEffect(() => {
    const timer = setTimeout(() => setActiveQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const load = async (replace: boolean) => {
    const generation = ++request.current;
    setLoading(true);
    setError(undefined);
    markUltraliteBackend("projects", "start");
    try {
      const result = await getAccountProjectWindow({
        bootstrap,
        request: {
          limit: PAGE_SIZE,
          offset: replace ? 0 : projects.length,
          search: activeQuery || undefined,
        },
      });
      if (generation !== request.current) return;
      markUltraliteBackend("projects", "end");
      setProjects((current) =>
        replace ? result.projects : [...current, ...result.projects],
      );
      setHasMore(result.hasMore);
    } catch (err) {
      markUltraliteBackend("projects", "end");
      recordUltraliteFailure("projects", err);
      if (generation === request.current) {
        setError(err instanceof Error ? err.message : `${err}`);
      }
    } finally {
      if (generation === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (firstQuery.current) {
      firstQuery.current = false;
      return;
    }
    setProjects([]);
    void load(true);
    // load is intentionally keyed by the debounced query only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeQuery]);

  useEffect(() => {
    if (!loading && !error) recordUltraliteSurfaceReady("projects");
  }, [error, loading]);

  return (
    <main className="ul-page ul-projects-page" id="main-content">
      <SurfaceHeader
        actions={
          <div className="ul-search-wrap">
            <label className="ul-visually-hidden" htmlFor="ul-project-search">
              Search projects
            </label>
            <input
              className="ul-search"
              id="ul-project-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects"
              type="search"
              value={query}
            />
          </div>
        }
        title="Projects"
      />
      {error ? <InlineAlert kind="error">{error}</InlineAlert> : null}
      <div className="ul-project-table" role="list">
        {projects.map((project) => {
          const state = stateLabel(project);
          const title = project.title || "Untitled project";
          const edited = project.last_edited || project.last_activity_at;
          return (
            <button
              aria-label={`Open project ${title}, ${state}`}
              className="ul-project-row"
              key={project.project_id}
              onClick={() =>
                navigate({
                  kind: "files",
                  projectId: project.project_id,
                  path: "/home/user",
                })
              }
              role="listitem"
              type="button"
            >
              <span
                aria-hidden="true"
                className="ul-project-avatar"
                style={{
                  borderColor:
                    typeof project.theme?.color === "string"
                      ? project.theme.color
                      : undefined,
                }}
              >
                {title.slice(0, 1).toUpperCase()}
              </span>
              <span className="ul-project-main">
                <strong>{title}</strong>
                {project.description ? (
                  <span className="ul-project-description">
                    {project.description}
                  </span>
                ) : null}
              </span>
              <span
                className={`ul-project-state ${state === "running" ? "ul-status-running" : ""}`}
              >
                {state}
              </span>
              <span className="ul-project-edited">
                {edited
                  ? new Date(edited).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : ""}
              </span>
            </button>
          );
        })}
      </div>
      {!projects.length && !loading ? (
        <EmptyState>No projects match this search.</EmptyState>
      ) : null}
      {loading ? <LoadingState label="Loading projects" /> : null}
      {hasMore ? (
        <button
          className="ul-button ul-button-secondary"
          disabled={loading}
          onClick={() => void load(false)}
          type="button"
        >
          Load more projects
        </button>
      ) : null}
    </main>
  );
}
