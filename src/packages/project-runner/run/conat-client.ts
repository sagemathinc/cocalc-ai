import { type Client as ConatClient } from "@cocalc/conat/core/client";

let client: ConatClient | null = null;

export function initConatClient(nextClient: ConatClient): void {
  client = nextClient;
}

export function getConatClient(): ConatClient {
  if (client == null) {
    throw new Error("project-runner Conat client not initialized");
  }
  return client;
}
