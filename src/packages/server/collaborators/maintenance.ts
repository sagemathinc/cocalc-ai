/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getLogger from "@cocalc/backend/logger";
import { createSharedProjectionFetcher } from "./projection-batch";
import { registerProjectionRevisionReceivers } from "./revision-registration";
import { runRevisionReceiverCleanup } from "./revision-maintenance";
import {
  syncCollaborationRevisionReceiverSchema,
  collaborationRevisionReceiverNeedsRenewal,
} from "@cocalc/database/postgres/collaborators/collaborators-revision-receiver";
import { syncCollaborationRevisionInterestSchema } from "@cocalc/database/postgres/collaborators/collaborators-revision-interest";
import getPool from "@cocalc/database/pool";
import {
  syncCollaborationDemandSchema,
  runCollaborationDemandActivation,
  demandSchedulingEnabled,
} from "@cocalc/database/postgres/collaborators/collaborators-demand";
import { runCollaborationFanoutPass } from "@cocalc/server/notifications/collaboration-fanout";
import {
  indexingWork,
  indexingPages,
  indexingPageSeconds,
  indexingPageBytes,
  measureOwnerProjectionFetch,
} from "./indexing-metrics";
import { runPeopleInvitationMaintenance } from "./invitations-runtime";
import { runPeopleInviteMaintenance } from "@cocalc/server/people/invite-maintenance";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  applyCollaborationProjection,
  claimCollaborationProjectionJobs,
  cleanCollaborationProjections,
  failCollaborationProjection,
  seedCollaborationProjectionJobs,
} from "@cocalc/database/postgres/collaborators/collaborators-projection";
import { syncCollaboratorsSchema } from "@cocalc/database/postgres/collaborators/collaborators-common";
import { compactNextCollaborationProject } from "@cocalc/database/postgres/collaborators/collaborators-owner";
import {
  applyCollaborationAccess,
  claimCollaborationAccess,
  failCollaborationAccess,
} from "@cocalc/database/postgres/collaborators/collaborators-access";
import {
  fetchCollaborationProjection,
  fetchCollaborationSharedProjection,
  fetchCollaborationAccessBatches,
  fetchCollaborationNotificationPage,
  deliverCollaborationNotificationObligation,
  collaboratorsControl,
} from "./api";
import {
  ensureCollaborationNotificationSchema,
  runCollaborationNotificationMaintenance,
} from "@cocalc/server/notifications/collaboration-state";

const logger = getLogger("server:collaborators:maintenance");
let timer: ReturnType<typeof setTimeout> | undefined;
let fanoutTimer: ReturnType<typeof setTimeout> | undefined;
let stopped = true;
let running = false;
let lifecycle = 0;
const accessTimers = new Set<ReturnType<typeof setTimeout>>();

export async function runCollaboratorsFanoutMaintenance() {
  if (
    process.env.COCALC_PEOPLE_EVENT_FANOUT_PROTOTYPE !== "1" ||
    !(await getServerSettings()).collaborators_enabled
  )
    return 0;
  return runCollaborationFanoutPass(
    getConfiguredBayId(),
    deliverCollaborationNotificationObligation,
  );
}

export async function runCollaboratorsAccessMaintenance() {
  if (!(await getServerSettings()).collaborators_enabled) return 0;
  const jobs = await claimCollaborationAccess(getConfiguredBayId());
  indexingWork.inc({ kind: "access_claimed" }, jobs.length);
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
            indexingWork.inc({ kind: "access_batch_attempted" });
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
    void runPeopleInvitationMaintenance().catch(() =>
      logger.warn(
        "people invitation maintenance failed; durable jobs retained",
      ),
    );
    await runPeopleInviteMaintenance();
    const bay_id = getConfiguredBayId();
    await runRevisionReceiverCleanup();
    if (process.env.COCALC_PEOPLE_DEMAND_PROTOTYPE === "1") {
      const activation = await runCollaborationDemandActivation(bay_id);
      indexingWork.inc(
        { kind: "demand_memberships_scheduled" },
        activation.scheduled,
      );
    }
    if (!demandSchedulingEnabled())
      indexingWork.inc(
        { kind: "memberships_enumerated" },
        await seedCollaborationProjectionJobs(bay_id),
      );
    await cleanCollaborationProjections(bay_id);
    await compactNextCollaborationProject(bay_id);
    const jobs = await claimCollaborationProjectionJobs(bay_id);
    indexingWork.inc({ kind: "projection_claimed" }, jobs.length);
    if (
      demandSchedulingEnabled() &&
      process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE === "1"
    ) {
      const registration = await registerProjectionRevisionReceivers(
        jobs,
        (project_id) =>
          collaborationRevisionReceiverNeedsRenewal(project_id, bay_id),
        (job) =>
          collaboratorsControl.registerRevisionReceiver({
            account_id: job.account_id,
            project_id: job.project_id,
            route: { bay_id },
          }),
      );
      indexingWork.inc(
        { kind: "revision_receivers_armed" },
        registration.armed,
      );
      indexingWork.inc(
        { kind: "revision_receivers_deferred" },
        registration.deferred,
      );
      indexingWork.inc(
        { kind: "revision_receivers_failed" },
        registration.failed,
      );
    }
    // Shared responses must not acquire a later access-lease start time merely
    // because another recipient begins awaiting the same in-flight request.
    const projectionRequestedAt = Date.now();
    const fetchPage =
      demandSchedulingEnabled() &&
      process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE === "1"
        ? createSharedProjectionFetcher(jobs, (request) =>
            measureOwnerProjectionFetch("shared", () =>
              fetchCollaborationSharedProjection(request),
            ),
          )
        : (job: (typeof jobs)[number]) =>
            measureOwnerProjectionFetch("individual", () =>
              fetchCollaborationProjection(job),
            );
    // At most eight bounded metadata pages in flight, with durable claims and
    // no waiting queue. Each page revalidates current owner membership.
    await Promise.all(
      jobs.map(async (job) => {
        const requested_at = projectionRequestedAt;
        const end = indexingPageSeconds.startTimer();
        let outcome = "failed";
        try {
          const page = await fetchPage(job);
          indexingPageBytes.inc(Buffer.byteLength(JSON.stringify(page)));
          const applied = await applyCollaborationProjection(
            job,
            page,
            requested_at,
          );
          outcome = !applied
            ? "superseded"
            : !page.allowed
              ? "denied"
              : page.items.length
                ? "changed"
                : "empty";
          if (!applied)
            await failCollaborationProjection(
              job,
              Error("superseded access grant"),
            );
        } catch (err) {
          outcome = "failed";
          await failCollaborationProjection(job, err);
        } finally {
          indexingPages.inc({ outcome });
          end();
        }
      }),
    );
    // Notifications consume only after metadata/attention projections have had a
    // chance to catch up; missing projections retain the durable retry cursor.
    if (!demandSchedulingEnabled())
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
    if (process.env.COCALC_PEOPLE_DEMAND_PROTOTYPE === "1")
      await syncCollaborationDemandSchema(getPool());
    if (
      demandSchedulingEnabled() &&
      process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE === "1"
    ) {
      await syncCollaborationRevisionReceiverSchema(getPool());
      await syncCollaborationRevisionInterestSchema(getPool());
    }
  } catch (err) {
    if (lifecycle === cycle) stopped = true;
    throw err;
  }
  if (stopped || lifecycle !== cycle) return;
  const fanoutTick = async () => {
    if (stopped || lifecycle !== cycle) return;
    try {
      await runCollaboratorsFanoutMaintenance();
    } catch {
      logger.warn(
        "notification fanout maintenance failed; durable work retained",
      );
    } finally {
      if (!stopped && lifecycle === cycle) {
        fanoutTimer = setTimeout(fanoutTick, 1000);
        fanoutTimer.unref();
      }
    }
  };
  fanoutTimer = setTimeout(fanoutTick, 0);
  fanoutTimer.unref();
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
  if (fanoutTimer) clearTimeout(fanoutTimer);
  fanoutTimer = undefined;
  for (const handle of accessTimers) clearTimeout(handle);
  accessTimers.clear();
}
