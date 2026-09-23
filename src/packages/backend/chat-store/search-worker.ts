import { parentPort, workerData } from "node:worker_threads";
import {
  searchChatStoreCombined,
  searchChatStoreArchived,
  searchChatArtifacts,
} from "./sqlite-offload";

if (parentPort) {
  void Promise.resolve()
    .then(() =>
      workerData.artifacts
        ? searchChatArtifacts(workerData)
        : workerData.include_head
          ? searchChatStoreCombined(workerData)
          : searchChatStoreArchived(workerData),
    )
    .then(
      (value) => parentPort!.postMessage({ value }),
      (error) => parentPort!.postMessage({ error: `${error}` }),
    );
}
