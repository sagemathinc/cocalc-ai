import { parentPort, workerData } from "node:worker_threads";
import {
  searchChatStoreCombined,
  searchChatStoreArchived,
} from "./sqlite-offload";

if (parentPort) {
  void Promise.resolve()
    .then(() =>
      workerData.include_head
        ? searchChatStoreCombined(workerData)
        : searchChatStoreArchived(workerData),
    )
    .then(
      (value) => parentPort!.postMessage({ value }),
      (error) => parentPort!.postMessage({ error: `${error}` }),
    );
}
