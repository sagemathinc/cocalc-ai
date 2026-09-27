/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getLogger from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  applyCollaborationProjection,
  claimCollaborationProjectionJobs,
  cleanCollaborationProjections,
  failCollaborationProjection,
  seedCollaborationProjectionJobs,
} from "@cocalc/database/postgres/collaborators-projection";
import { syncCollaboratorsSchema } from "@cocalc/database/postgres/collaborators-common";
import { compactNextCollaborationProject } from "@cocalc/database/postgres/collaborators-owner";
import {
  applyCollaborationAccess,
  claimCollaborationAccess,
  failCollaborationAccess,
} from "@cocalc/database/postgres/collaborators-access";
import {
  fetchCollaborationProjection,
  fetchCollaborationAccessBatches,
  fetchCollaborationNotificationPage,
} from "./api";
import {
  ensureCollaborationNotificationSchema,
  runCollaborationNotificationMaintenance,
} from "@cocalc/server/notifications/collaboration-state";

const logger = getLogger("server:collaborators:maintenance");
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = true;
let running = false;
let lifecycle = 0;
const accessTimers = new Set<ReturnType<typeof setTimeout>>();

export async function runCollaboratorsAccessMaintenance() {
  if (!(await getServerSettings()).collaborators_enabled) return 0;
  const jobs = await claimCollaborationAccess(getConfiguredBayId());
  if (!jobs.length) return 0;
  try {
    const groups = await fetchCollaborationAccessBatches(jobs);
    // Four remote destinations per worker, eight independently scheduled workers.
    // A slow source page or failed owner never blocks other workers renewing leases.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, groups.length) }, async () => {
        while (next < groups.length) {
          const group = groups[next++];
          const requested_at = Date.now();
          try {
            await applyCollaborationAccess(
              group.jobs,
              await group.fetch(),
              requested_at,
            );
          } catch {
            await failCollaborationAccess(group.jobs);
          }
        }
      }),
    );
  } catch {
    await failCollaborationAccess(jobs);
  }
  return jobs.length;
}

export async function runCollaboratorsMaintenance() {
  if (running) return;
  running = true;
  try {
    if (!(await getServerSettings()).collaborators_enabled) return;
    const bay_id = getConfiguredBayId();
    await seedCollaborationProjectionJobs(bay_id);
    await cleanCollaborationProjections(bay_id);
    await compactNextCollaborationProject(bay_id);
    const jobs = await claimCollaborationProjectionJobs(bay_id);
    // At most eight bounded metadata pages in flight, with durable claims and
    // no waiting queue. Each page revalidates current owner membership.
    await Promise.all(
      jobs.map(async (job) => {
        const requested_at = Date.now();
        try {
          const applied = await applyCollaborationProjection(
            job,
            await fetchCollaborationProjection(job),
            requested_at,
          );
          if (!applied)
            await failCollaborationProjection(
              job,
              Error("superseded access grant"),
            );
        } catch (err) {
          await failCollaborationProjection(job, err);
        }
      }),
    );
    // Notifications consume only after metadata/attention projections have had a
    // chance to catch up; missing projections retain the durable retry cursor.
    await runCollaborationNotificationMaintenance(
      fetchCollaborationNotificationPage,
    );
  } finally {
    running = false;
  }
}
export async function startCollaboratorsMaintenance() {
  if (!stopped) return;
  stopped = false;
  const cycle = ++lifecycle;
  try {
    await syncCollaboratorsSchema();
    await ensureCollaborationNotificationSchema();
  } catch (err) {
    if (lifecycle === cycle) stopped = true;
    throw err;
  }
  if (stopped || lifecycle !== cycle) return;
  for (let i = 0; i < 8; i++) {
    const accessTick = async () => {
      if (stopped || lifecycle !== cycle) return;
      let renewed = 0;
      try {
        renewed = await runCollaboratorsAccessMaintenance();
      } catch (err) {
        logger.warn("access renewal failed", { error: String(err) });
      } finally {
        if (!stopped && lifecycle === cycle) {
          const handle = setTimeout(
            () => {
              accessTimers.delete(handle);
              void accessTick();
            },
            renewed ? 100 : 1000,
          );
          accessTimers.add(handle);
          handle.unref();
        }
      }
    };
    const handle = setTimeout(() => {
      accessTimers.delete(handle);
      void accessTick();
    }, i * 20);
    accessTimers.add(handle);
    handle.unref();
  }
  const tick = async () => {
    if (stopped || lifecycle !== cycle) return;
    try {
      await runCollaboratorsMaintenance();
    } catch (err) {
      logger.warn("maintenance pass failed", { error: String(err) });
    } finally {
      if (!stopped && lifecycle === cycle) {
        timer = setTimeout(tick, 100);
        timer.unref();
      }
    }
  };
  timer = setTimeout(tick, 0);
  timer.unref();
}
export function stopCollaboratorsMaintenance() {
  stopped = true;
  lifecycle++;
  if (timer) clearTimeout(timer);
  timer = undefined;
  for (const handle of accessTimers) clearTimeout(handle);
  accessTimers.clear();
}
