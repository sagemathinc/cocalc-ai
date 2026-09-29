/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { posix } from "node:path";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { CollaborationCensusStore } from "@cocalc/backend/collaborators/census-store";
import { createCensusProducer } from "@cocalc/backend/collaborators/census-producer";
import { censusReporter } from "@cocalc/backend/collaborators/census-report";
import { censusCapacityFromEnvironment } from "@cocalc/backend/collaborators/census-types";
import { censusPolicyFromEnvironment } from "@cocalc/backend/collaborators/census-policy";
import type { CensusPolicy } from "@cocalc/backend/collaborators/census-policy";
import type {
  CensusRun,
  CensusCapacity,
} from "@cocalc/backend/collaborators/census-types";
import type { CollaborationDiscoveryWrite } from "@cocalc/util/collaboration-census";

/** Standalone Lite only. Uses its already configured disk root, never a container. */
export function createLiteCollaborationCensus(options: {
  filename: string;
  project_id: string;
  account_id: string;
  root: string;
  excluded_paths?: string[];
  enabled(): Promise<boolean>;
  createFilesystem(): SandboxedFilesystem;
  current(project_id: string): Promise<{ run_id: string | null }>;
  report(write: CollaborationDiscoveryWrite): Promise<unknown>;
  onError(error: unknown): void;
  now?: () => number;
  capacity?: CensusCapacity;
  policy?: CensusPolicy;
  /** Isolated legacy test harness only; production never enables inventory. */
  inventory?: boolean;
}) {
  const policy = options.policy ?? censusPolicyFromEnvironment();
  const store = new CollaborationCensusStore(
    options.filename,
    options.capacity ?? censusCapacityFromEnvironment(),
  );
  const now = options.now ?? Date.now;
  const root = posix.normalize(options.root);
  const authority = `lite:${options.account_id}`;
  const excluded_paths = [
    ...new Set([
      posix.join(root, ".snapshots"),
      posix.join(root, ".trash"),
      ...(options.excluded_paths ?? []),
    ]),
  ].sort();
  const identity = async () => {
    const stat = await lstat(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Lite census root unavailable");
    return `${stat.dev}:${stat.ino}`;
  };
  const validate = async (run: CensusRun) => {
    if (
      run.project_id !== options.project_id ||
      run.authority !== authority ||
      !(await options.enabled()) ||
      run.volume_id !== (await identity())
    )
      throw Object.assign(Error("Lite census authority or volume changed"), {
        code: "ESTALE",
      });
  };
  const producer = createCensusProducer({
    store,
    enabled: options.enabled,
    now,
    validate,
    onError: options.onError,
    publish: censusReporter({
      store,
      current: options.current,
      send: options.report,
      now,
      enabled: options.enabled,
    }),
    prepare: async () => {
      if (!options.inventory) return;
      let volume_id: string;
      try {
        volume_id = await identity();
      } catch {
        volume_id = "unavailable";
      }
      const prior = store.status(options.project_id);
      const sameScope =
        prior?.run.volume_id === volume_id &&
        prior.run.authority === authority &&
        prior.run.root === root;
      if (
        prior &&
        sameScope &&
        prior.run.policy_version === policy.version &&
        JSON.stringify(prior.run.limits) === JSON.stringify(policy.limits) &&
        JSON.stringify(prior.run.excluded_paths) ===
          JSON.stringify(excluded_paths) &&
        (!prior.traversal_complete ||
          prior.pending_candidates ||
          now() - prior.started_at < 60 * 60_000)
      )
        return;
      const request = {
        project_id: options.project_id,
        run_id: randomUUID(),
        root,
        authority,
        volume_id,
        policy_version: policy.version,
        limits: policy.limits,
        excluded_paths,
      };
      if (prior && sameScope) store.rescan(request, prior.run.run_id, now());
      else store.begin(request, prior?.run.run_id, now());
    },
    openReader: async (run) => {
      await validate(run);
      const fs = options.createFilesystem();
      let closed = false;
      return {
        assertCurrent: async () => {
          if (closed) throw Error("Lite census reader closed");
          await validate(run);
        },
        // Lite's absolute native home otherwise resolves through its rootfs
        // alias; use project-relative inputs to stay on the configured home.
        openDirectory: (path) =>
          fs.openDirectoryStream(posix.relative(run.root, path) || ".", "."),
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
