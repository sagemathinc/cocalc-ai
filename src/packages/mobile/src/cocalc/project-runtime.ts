/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { SiteSession } from "./site-session";

const START_TIMEOUT_MS = 2 * 60 * 1000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureProjectRunning(
  session: SiteSession,
  projectId: string,
  onState?: (state: string) => void,
): Promise<void> {
  let state = await session.hubApi.projects.getProjectState({
    project_id: projectId,
  });
  if (state.state === "running") return;
  if (state.error) throw new Error(state.error);
  onState?.("Starting project…");
  await session.hubApi.projects.start({
    project_id: projectId,
    autostart: true,
    wait: false,
  });
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await wait(750);
    state = await session.hubApi.projects.getProjectState({
      project_id: projectId,
    });
    if (state.state === "running") return;
    if (state.error) throw new Error(state.error);
    onState?.(`Project is ${state.state ?? "starting"}…`);
  }
  throw new Error("Timed out waiting for the project to start.");
}
