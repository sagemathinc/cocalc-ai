/*
Hook for getting a FilesystemClient.
*/
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { type FilesystemClient } from "@cocalc/conat/files/fs";
import { getLogger } from "@cocalc/conat/logger";
import { useEffect, useState } from "react";

const logger = getLogger("frontend:project:listing:use-fs");

// this will probably get more complicated temporarily when we
// are transitioning between filesystems (hence why we return null in
// the typing for now)
export default function useFs({
  project_id,
}: {
  project_id: string;
}): FilesystemClient | null {
  const [fs, setFs] = useState<FilesystemClient | null>(null);

  useEffect(() => {
    let canceled = false;
    setFs(null);
    webapp_client.conat_client
      .projectFs({ project_id, caller: "useFs" })
      .then((fs) => {
        if (!canceled) {
          setFs(fs);
        }
      })
      .catch((err) => {
        if (!canceled) {
          logger.warn(`unable to initialize filesystem client: ${err}`);
          setFs(null);
        }
      });
    return () => {
      canceled = true;
    };
  }, [project_id]);

  return fs;
}
