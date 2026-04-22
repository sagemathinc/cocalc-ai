import getLogger from "@cocalc/backend/logger";
import callHub from "@cocalc/conat/hub/call-hub";
import { setGeneratedImageBlobWriter } from "@cocalc/lite/hub/acp";
import { getMasterConatClient } from "../master-status";
import { getLocalHostId } from "../sqlite/hosts";

const logger = getLogger("project-host:codex:generated-image-blobs");

export function initCodexGeneratedImageBlobWriter(): void {
  setGeneratedImageBlobWriter(
    async ({ uuid, blob, accountId, projectId }): Promise<void> => {
      const client = getMasterConatClient();
      const host_id = getLocalHostId();
      if (!client || !host_id) {
        throw Error(
          "master conat client and host id are required to upload generated image blobs",
        );
      }
      if (!projectId) {
        throw Error("project_id is required to upload generated image blobs");
      }
      await callHub({
        client,
        host_id,
        name: "db.saveBlob",
        args: [
          {
            account_id: accountId,
            project_id: projectId,
            uuid,
            blob: blob.toString("base64"),
          },
        ],
        timeout: 60_000,
      });
      logger.debug("uploaded generated image blob through master hub", {
        uuid,
        bytes: blob.byteLength,
        projectId,
        accountId,
      });
    },
  );
}
