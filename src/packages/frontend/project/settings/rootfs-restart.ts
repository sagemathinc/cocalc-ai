/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export async function queueRootfsChangeRestart({
  project_id,
  restartProject,
  setRestartQueuedAt,
}: {
  project_id: string;
  restartProject: (project_id: string) => Promise<void> | void;
  setRestartQueuedAt: (value: string) => void;
}): Promise<void> {
  setRestartQueuedAt(new Date().toISOString());
  try {
    await restartProject(project_id);
  } catch (err) {
    setRestartQueuedAt("");
    throw new Error(`RootFS image changed, but project restart failed: ${err}`);
  }
}
