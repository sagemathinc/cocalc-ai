import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isWorkspaceProjectRuntime } from "@cocalc/server/launchpad/project-runtime";
import { getProject } from "@cocalc/server/projects/control";

const logger = getLogger("server:conat:project:workspace-reconcile");
const INTERVAL_MS = 10_000;

export async function reconcileWorkspaceProjectStates(
  isClosed: () => boolean = () => false,
): Promise<void> {
  if (!isWorkspaceProjectRuntime() || isClosed()) return;
  const { rows } = await getPool().query<{ project_id: string }>(
    `SELECT project_id FROM projects
     WHERE state->>'state'='running'
       AND host_id IS NULL
       AND deleted IS NOT TRUE
       AND COALESCE(owning_bay_id, $1)=$1`,
    [getConfiguredBayId()],
  );
  for (const { project_id } of rows) {
    if (isClosed()) return;
    try {
      // The runner load balancer's status RPC persists the observed state via
      // setProjectState, including opened when no workspace record exists.
      // Never infer a stopped project just from a failed RPC.
      await getProject(project_id).state();
    } catch (err) {
      logger.warn("unable to reconcile workspace project", {
        project_id,
        err: `${err}`,
      });
    }
  }
}

export function startWorkspaceProjectReconciliation(): () => void {
  if (!isWorkspaceProjectRuntime()) return () => {};
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      await reconcileWorkspaceProjectStates(() => closed);
    } catch (err) {
      logger.warn("workspace reconciliation failed", { err: `${err}` });
    } finally {
      if (!closed) {
        timer = setTimeout(() => void tick(), INTERVAL_MS);
        timer.unref();
      }
    }
  };
  // Run after the runner and load balancer have registered their services.
  void tick();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
  };
}
