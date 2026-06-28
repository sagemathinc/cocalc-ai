/*
Hook for getting a FilesystemClient.
*/
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { type FilesystemClient } from "@cocalc/conat/files/fs";
import { getLogger } from "@cocalc/conat/logger";
import { sleep, withTimeout } from "@cocalc/util/async-utils";
import { useCallback, useEffect, useState } from "react";
import { useProjectContext } from "@cocalc/frontend/project/context";

const logger = getLogger("frontend:project:listing:use-fs");
const PROJECT_FS_TIMEOUT_MS = 10000;
const PROJECT_FS_RETRY_DELAYS_MS = [1000, 2000, 5000] as const;

type ConatErrorLike = Error & { code?: string | number; data?: unknown };

function logPublicShareFs(
  level: "info" | "warn",
  message: string,
  details: Record<string, unknown>,
) {
  const payload = {
    source: "frontend:project:listing:use-fs",
    event: message,
    ...details,
  };
  const line = `[public-directory-share] ${message} ${JSON.stringify(payload)}`;
  if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

function isRetryableProjectFsError(err: unknown): boolean {
  const code = String((err as ConatErrorLike | undefined)?.code ?? "");
  if (code === "408") {
    return true;
  }
  const message =
    `${(err as ConatErrorLike | undefined)?.message ?? err ?? ""}`.toLowerCase();
  return (
    message.includes("retry in about") ||
    message.includes("project-host auth token retry cooldown active") ||
    message.includes("failed to sign in") ||
    message.includes("missing project-host bearer token") ||
    message.includes("no subscribers matching") ||
    message.includes("timeout") ||
    message.includes("unable to route") ||
    message.includes("host routing info unavailable") ||
    message.includes("project host id unavailable") ||
    message.includes("project not running") ||
    message.includes("not running") ||
    message.includes("not ready") ||
    message.includes('once: "ready" not emitted before "closed"') ||
    message.includes('once: "inbox" not emitted before "closed"') ||
    message.includes("timed out")
  );
}

// this will probably get more complicated temporarily when we
// are transitioning between filesystems (hence why we return null in
// the typing for now)
export default function useFs({
  project_id,
  viewer,
  enabled = true,
}: {
  project_id: string;
  viewer?: boolean;
  enabled?: boolean;
}): FilesystemClient | null {
  const { publicDirectoryShare } = useProjectContext();
  return useFsWithRefresh({
    project_id,
    viewer,
    share_id: publicDirectoryShare?.id,
    enabled,
  }).fs;
}

export function useFsWithRefresh({
  project_id,
  enabled = true,
  share_id,
  viewer,
}: {
  project_id: string;
  enabled?: boolean;
  share_id?: string;
  viewer?: boolean;
}): { fs: FilesystemClient | null; refreshFs: () => void } {
  const [fs, setFs] = useState<FilesystemClient | null>(null);
  const [generation, setGeneration] = useState(0);
  const refreshFs = useCallback(() => {
    setFs(null);
    setGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    let canceled = false;
    setFs(null);
    if (!enabled) {
      return;
    }
    const connect = async () => {
      let attempt = 0;
      while (!canceled) {
        const started = Date.now();
        if (share_id) {
          logPublicShareFs("info", "filesystem bootstrap start", {
            project_id,
            share_id,
            attempt: attempt + 1,
            viewer,
          });
        }
        try {
          const nextFs = await withTimeout(
            webapp_client.conat_client.projectFs({
              project_id,
              caller: share_id
                ? "useFs.share"
                : viewer
                  ? "useFs.viewer"
                  : "useFs",
              share_id,
              viewer,
            }),
            PROJECT_FS_TIMEOUT_MS,
          );
          if (!canceled) {
            setFs(nextFs);
          }
          if (share_id) {
            logPublicShareFs("info", "filesystem bootstrap ready", {
              project_id,
              share_id,
              attempt: attempt + 1,
              elapsed_ms: Date.now() - started,
            });
          }
          return;
        } catch (err) {
          if (canceled) {
            return;
          }
          const retryable = isRetryableProjectFsError(err);
          logger.warn(`unable to initialize filesystem client: ${err}`);
          if (share_id) {
            logPublicShareFs("warn", "filesystem bootstrap failed", {
              project_id,
              share_id,
              attempt: attempt + 1,
              elapsed_ms: Date.now() - started,
              retryable,
              code: (err as ConatErrorLike | undefined)?.code,
              message: `${(err as ConatErrorLike | undefined)?.message ?? err}`,
            });
          }
          setFs(null);
          if (!retryable) {
            return;
          }
          const delayMs =
            PROJECT_FS_RETRY_DELAYS_MS[
              Math.min(attempt, PROJECT_FS_RETRY_DELAYS_MS.length - 1)
            ];
          attempt += 1;
          await sleep(delayMs);
        }
      }
    };
    void connect();
    return () => {
      canceled = true;
    };
  }, [enabled, generation, project_id, share_id, viewer]);

  return { fs, refreshFs };
}
