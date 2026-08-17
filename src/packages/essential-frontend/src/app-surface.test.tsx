/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import AppSurface from "./app-surface";
import type { UltraliteSession } from "./session";

const project = {
  host_id: "33333333-3333-4333-8333-333333333333",
  project_id: "11111111-1111-4111-8111-111111111111",
  title: "Test project",
} as AccountProjectListWindowRow;

function makeSession() {
  const status = jest.fn(async () => ({
    state: "running",
    ready: true,
    url: "/app",
  }));
  const start = jest.fn(async () => ({ state: "starting" }));
  const waitForState = jest.fn(async () => undefined);
  const stop = jest.fn(async () => undefined);
  const getProjectState = jest.fn(async () => ({ state: "stopped" }));
  const ensureProjectRunning = jest.fn(async () => undefined);
  const openProjectApi = jest.fn(async () => ({
    api: { apps: { start, status, stop, waitForState } },
  }));
  const session = {
    ensureProjectRunning,
    getProjectState,
    openProjectApi,
  } as unknown as UltraliteSession;
  return {
    ensureProjectRunning,
    getProjectState,
    openProjectApi,
    session,
    start,
    status,
    stop,
    waitForState,
  };
}

test("opening and refreshing Apps never starts project compute", async () => {
  const {
    ensureProjectRunning,
    getProjectState,
    openProjectApi,
    session,
    start,
  } = makeSession();

  render(<AppSurface project={project} session={session} />);
  await screen.findByText(/This project is stopped/);

  expect(getProjectState).toHaveBeenCalledTimes(1);
  expect(ensureProjectRunning).not.toHaveBeenCalled();
  expect(openProjectApi).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
  await waitFor(() => expect(getProjectState).toHaveBeenCalledTimes(2));
  expect(ensureProjectRunning).not.toHaveBeenCalled();
  expect(openProjectApi).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

test("starting an app is the explicit compute-start boundary", async () => {
  const {
    ensureProjectRunning,
    openProjectApi,
    session,
    start,
    status,
    waitForState,
  } = makeSession();

  render(<AppSurface project={project} session={session} />);
  await screen.findByText(/This project is stopped/);
  fireEvent.click(screen.getAllByRole("button", { name: "Start" })[0]);

  await waitFor(() => expect(start).toHaveBeenCalledWith("jupyterlab"));
  expect(ensureProjectRunning).toHaveBeenCalledWith(project.project_id);
  expect(openProjectApi).toHaveBeenCalledWith(
    project.project_id,
    project.host_id,
  );
  expect(waitForState).toHaveBeenCalledWith("jupyterlab", "running", {
    interval: 1000,
    timeout: 120_000,
  });
  expect(status).toHaveBeenCalledWith("jupyterlab");
});
