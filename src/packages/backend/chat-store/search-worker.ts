import { parentPort, workerData } from "node:worker_threads";
import { searchChatStoreCombined } from "./sqlite-offload";

if (parentPort) {
  void searchChatStoreCombined(workerData).then(
    (value) => parentPort!.postMessage({ value }),
    (error) => parentPort!.postMessage({ error: `${error}` }),
  );
}
