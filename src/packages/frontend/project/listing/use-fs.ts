/*
Hook for getting a FilesystemClient.
*/
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { type FilesystemClient } from "@cocalc/conat/files/fs";
import { getLogger } from "@cocalc/conat/logger";
import { sleep } from "@cocalc/util/async-utils";
import { useCallback, useEffect, useState } from "react";

const logger = getLogger("frontend:project:listing:use-fs");
const PROJECT_FS_RETRY_DELAYS_MS = [1000, 2000, 5000] as const;

type ConatErrorLike = Error & { code?: string | number; data?: unknown };

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
}: {
  project_id: string;
  viewer?: boolean;
}): FilesystemClient | null {
  return useFsWithRefresh({ project_id, viewer }).fs;
}

export function useFsWithRefresh({
  project_id,
  viewer,
}: {
  project_id: string;
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
    const connect = async () => {
      let attempt = 0;
      while (!canceled) {
        try {
          const nextFs = await webapp_client.conat_client.projectFs({
            project_id,
            caller: viewer ? "useFs.viewer" : "useFs",
            viewer,
          });
          if (!canceled) {
            setFs(nextFs);
          }
          return;
        } catch (err) {
          if (canceled) {
            return;
          }
          logger.warn(`unable to initialize filesystem client: ${err}`);
          setFs(null);
          if (!isRetryableProjectFsError(err)) {
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
  }, [generation, project_id, viewer]);

  return { fs, refreshFs };
}
