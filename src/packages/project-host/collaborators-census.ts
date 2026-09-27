/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { CollaborationCensusStore } from "@cocalc/backend/collaborators/census-store";
import { censusCapacityFromEnvironment } from "@cocalc/backend/collaborators/census-types";
import { censusPolicyFromEnvironment } from "@cocalc/backend/collaborators/census-policy";
import type { CensusPolicy } from "@cocalc/backend/collaborators/census-policy";
import type {
  CensusRun,
  CensusCapacity,
} from "@cocalc/backend/collaborators/census-types";
import { createCensusProducer } from "@cocalc/backend/collaborators/census-producer";
import { censusReporter } from "@cocalc/backend/collaborators/census-report";
import type { CollaborationDiscoveryWrite } from "@cocalc/util/collaboration-census";
import { getProject, nextCollaborationCensusProject } from "./sqlite/projects";
import { getLocalHostId } from "./sqlite/hosts";
import { getRecordedProjectVolumeIdentity } from "./sqlite/project-volumes";
import {
  assertProjectVolumeLifecycleGeneration,
  currentProjectVolumeLifecycleGeneration,
  withProjectVolumeLifecycleLock,
} from "./project-volume-lifecycle";

const ROOT = "/home/user";
const EXCLUDED = [ROOT + "/.snapshots", ROOT + "/.trash"];
const RECHECK_MS = 60 * 60_000;
function unavailable(code: string) {
  return Object.assign(Error(`collaboration census ${code}`), { code });
}

export function createHostedCollaborationCensus(options: {
  filename: string;
  getFilesystem(project_id: string): Promise<SandboxedFilesystem>;
  /** Existing host-authenticated, owner-routed metadata check; no initialization. */
  authorize(project_id: string): Promise<void>;
  current(project_id: string): Promise<{ run_id: string | null }>;
  report(write: CollaborationDiscoveryWrite): Promise<unknown>;
  enabled(): Promise<boolean>;
  onError(error: unknown): void;
  now?: () => number;
  capacity?: CensusCapacity;
  policy?: CensusPolicy;
}) {
  const policy = options.policy ?? censusPolicyFromEnvironment();
  const store = new CollaborationCensusStore(
    options.filename,
    options.capacity ?? censusCapacityFromEnvironment(),
  );
  const now = options.now ?? Date.now;
  function scope(project_id: string) {
    const project = getProject(project_id);
    const host = getLocalHostId();
    if (!project || project.local_only || project.exam_run_id || !host)
      throw unavailable("PROJECT_UNAVAILABLE");
    return {
      authority: `host:${host}`,
      volume_id:
        getRecordedProjectVolumeIdentity(project_id, "home") ?? "unavailable",
    };
  }
  function assertLocal(run: CensusRun) {
    const current = scope(run.project_id);
    if (run.volume_id === "unavailable") throw unavailable("ENODEV");
    if (
      current.authority !== run.authority ||
      current.volume_id !== run.volume_id
    )
      throw unavailable("ESTALE");
  }
  const validate = async (run: CensusRun) => {
    assertLocal(run);
    if (!(await options.enabled())) throw unavailable("DISABLED");
    await options.authorize(run.project_id);
    assertLocal(run);
  };
  const producer = createCensusProducer({
    store,
    enabled: options.enabled,
    now,
    onError: options.onError,
    publish: censusReporter({
      store,
      current: options.current,
      send: options.report,
      now,
      enabled: options.enabled,
    }),
    validate,
    prepare: async () => {
      const nextRound = Number(store.checkpoint("host-next-round") ?? 0);
      if (now() < nextRound) return;
      const after = store.checkpoint("host-project") ?? "";
      const project_id = nextCollaborationCensusProject(after);
      if (!project_id) {
        store.setCheckpoint("host-project", "");
        const phase = store.checkpoint("host-phase") ?? "new";
        store.setCheckpoint("host-phase", phase === "new" ? "refresh" : "new");
        store.setCheckpoint(
          "host-next-round",
          String(phase === "new" ? now() : now() + 30_000),
        );
        return;
      }
      try {
        const current = scope(project_id);
        const prior = store.status(project_id);
        const sameScope =
          prior?.run.authority === current.authority &&
          prior.run.volume_id === current.volume_id &&
          prior.run.root === ROOT;
        if (
          prior &&
          sameScope &&
          prior.run.policy_version === policy.version &&
          JSON.stringify(prior.run.limits) === JSON.stringify(policy.limits) &&
          ((store.checkpoint("host-phase") ?? "new") === "new" ||
            !prior.traversal_complete ||
            prior.pending_candidates ||
            now() - prior.started_at < RECHECK_MS)
        )
          return;
        const request = {
          project_id,
          run_id: randomUUID(),
          ...current,
          root: ROOT,
          policy_version: policy.version,
          limits: policy.limits,
          excluded_paths: EXCLUDED,
        };
        if (prior && sameScope) store.rescan(request, prior.run.run_id, now());
        else store.begin(request, prior?.run.run_id, now());
      } finally {
        // One unavailable/quota-bound project must not starve every later project.
        store.setCheckpoint("host-project", project_id);
      }
    },
    openReader: async (run) => {
      await validate(run);
      const generation = currentProjectVolumeLifecycleGeneration(
        run.project_id,
      );
      const fs = await withProjectVolumeLifecycleLock(
        run.project_id,
        async () => {
          assertProjectVolumeLifecycleGeneration(run.project_id, generation);
          assertLocal(run);
          return options.getFilesystem(run.project_id);
        },
      );
      let closed = false;
      const assertCurrent = async () => {
        if (closed) throw unavailable("EBADF");
        assertProjectVolumeLifecycleGeneration(run.project_id, generation);
        await validate(run);
        assertProjectVolumeLifecycleGeneration(run.project_id, generation);
      };
      return {
        assertCurrent,
        openDirectory: (path: string) =>
          withProjectVolumeLifecycleLock(run.project_id, async () => {
            await assertCurrent();
            const stream = await fs.openDirectoryStream(path, run.root);
            try {
              assertProjectVolumeLifecycleGeneration(
                run.project_id,
                generation,
              );
              assertLocal(run);
              return {
                read: () => stream.read(),
                close: () => stream.close(),
                assertCurrent: async () => {
                  await stream.assertCurrent();
                  assertProjectVolumeLifecycleGeneration(
                    run.project_id,
                    generation,
                  );
                  assertLocal(run);
                },
              };
            } catch (error) {
              await stream.close();
              throw error;
            }
          }),
        close: async () => {
          if (!closed) {
            closed = true;
            fs.close();
          }
        },
      };
    },
  });
  return { store, producer };
}
