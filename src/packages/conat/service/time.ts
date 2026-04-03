/*
Time service -- tell me what time you think it is.

This is a global service that is run by hubs.
*/

import { createServiceClient, createServiceHandler } from "./typed";
import type { Client } from "@cocalc/conat/core/client";

interface TimeApi {
  // time in ms since epoch, i.e., Date.now()
  time: () => Promise<number>;
}

const SUBJECT = process.env.COCALC_TEST_MODE ? "time-test" : "time";

interface User {
  account_id?: string;
  project_id?: string;
}

interface TimeClientOptions extends User {
  client: Client;
}

function requireClient(client: Client | undefined): Client {
  if (client == null) {
    throw Error("time service helper must provide an explicit Conat client");
  }
  return client;
}

function timeSubject({ account_id, project_id }: User) {
  if (account_id) {
    return `${SUBJECT}.account-${account_id}.api`;
  } else if (project_id) {
    return `${SUBJECT}.project-${project_id}.api`;
  } else {
    return `${SUBJECT}.hub.api`;
  }
}

export function timeClient(user: TimeClientOptions) {
  const subject = timeSubject(user);
  return createServiceClient<TimeApi>({
    client: requireClient(user.client),
    service: "time",
    subject,
  });
}

export async function createTimeService({ client }: { client: Client }) {
  return await createServiceHandler<TimeApi>({
    client: requireClient(client),
    service: "time",
    subject: `${SUBJECT}.*.api`,
    description: "Time service -- tell me what time you think it is.",
    impl: { time: async () => Date.now() },
  });
}
