import getLogger from "@cocalc/backend/logger";
import callHub from "@cocalc/conat/hub/call-hub";
import {
  setAttachmentBlobReader,
  setGeneratedImageBlobWriter,
} from "@cocalc/lite/hub/acp";
import { getMasterConatClient } from "../master-conat-client";
import { getLocalHostId } from "../sqlite/hosts";

const logger = getLogger("project-host:codex:generated-image-blobs");

export function initCodexAttachmentBlobReader(): void {
  setAttachmentBlobReader(
    async ({ uuid, projectId }): Promise<Buffer | undefined> => {
      const client = getMasterConatClient();
      const host_id = getLocalHostId();
      if (!client || !host_id) {
        throw Error(
          "master conat client and host id are required to read chat attachment blobs",
        );
      }
      const result = await callHub({
        client,
        host_id,
        name: "db.getBlob",
        args: [{ project_id: projectId, uuid }],
        timeout: 60_000,
      });
      return result.blob == null
        ? undefined
        : Buffer.from(result.blob, "base64");
    },
  );
}

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
