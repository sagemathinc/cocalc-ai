/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import {
  claudeSubscriptionBundleFiles,
  readClaudeSubscriptionHomeFiles,
} from "./claude-subscription-home";
import { syncClaudeSubscriptionCredential } from "./claude-subscription-registry";

const logger = getLogger("project-host:acp:claude-credential-sync");

// Save a refreshed subscription token promptly, not only when the controller
// stops: other controllers start from the stored copy.
const SYNC_INTERVAL_MS = 60_000;
// The final sync after stop retries from an in-memory snapshot.
const FINAL_RETRY_DELAYS_MS = [1_000, 3_000];

type Files = ReadonlyMap<string, Buffer>;

/**
 * Keeps the stored Claude subscription credential in step with one
 * controller's home: periodic syncs while it runs and a final sync after it
 * stops. Only the paths of the restored bundle are ever read back.
 */
export function createClaudeCredentialSync(options: {
  projectId: string;
  accountId: string;
  credentialId: string;
  home: string;
  // The stored payload the home was restored from.
  restoredPayload: string;
  intervalMs?: number;
  finalRetryDelaysMs?: number[];
  // For tests.
  read?: (home: string, paths: string[]) => Promise<Files>;
  sync?: typeof syncClaudeSubscriptionCredential;
}) {
  const {
    projectId,
    accountId,
    credentialId,
    home,
    intervalMs = SYNC_INTERVAL_MS,
    finalRetryDelaysMs = FINAL_RETRY_DELAYS_MS,
    read = readClaudeSubscriptionHomeFiles,
    sync = syncClaudeSubscriptionCredential,
  } = options;
  // This controller's credential files as of its last sync.
  let baseline: Files = claudeSubscriptionBundleFiles(options.restoredPayload);
  const paths = [...baseline.keys()];
  // Taken once after the controller stops, so a failed final sync can still
  // be retried after its home is removed.
  let finalFiles: Files | undefined;
  let running: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;

  const syncOnce = (current?: Files) =>
    (running = running
      .catch(() => {})
      .then(async () => {
        baseline = await sync({
          projectId,
          accountId,
          credentialId,
          baseline,
          current: current ?? (await read(home, paths)),
        });
      }));

  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };

  return {
    /** Sync periodically while the controller runs. */
    start() {
      stop();
      timer = setInterval(() => {
        syncOnce().catch((error) =>
          logger.warn("Claude credential sync failed", error),
        );
      }, intervalMs);
      timer.unref?.();
    },
    /** Stop periodic syncs and wait for one in flight. */
    async idle() {
      stop();
      await running.catch(() => {});
    },
    /**
     * After the controller stopped: snapshot its home once, then sync from
     * the snapshot, retrying briefly. Later calls retry from the snapshot.
     */
    async finish() {
      await this.idle();
      finalFiles ??= await read(home, paths);
      for (let attempt = 0; ; attempt++) {
        try {
          await syncOnce(finalFiles);
          return;
        } catch (error) {
          const delay = finalRetryDelaysMs[attempt];
          if (delay == null) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    },
  };
}
