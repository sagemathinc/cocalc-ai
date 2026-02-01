/*
Create a connection to a conat server authenticated as a project, via an api
key or the project secret token.
*/

import * as backendData from "@cocalc/backend/data";
import {
  connect,
  type Client as ConatClient,
  type ClientOptions,
} from "@cocalc/conat/core/client";
import {
  API_COOKIE_NAME,
  PROJECT_SECRET_COOKIE_NAME,
  PROJECT_ID_COOKIE_NAME,
} from "@cocalc/backend/auth/cookie-names";
import { inboxPrefix } from "@cocalc/conat/names";
import { setConatClient } from "@cocalc/conat/client";
import * as projectData from "@cocalc/project/data";
import { getLogger } from "@cocalc/project/logger";
import { is_valid_uuid_string } from "@cocalc/util/misc";
import { versionCheckLoop } from "./hub";

const data = { ...backendData, ...projectData };

const logger = getLogger("conat:connection");

function normalizeProjectId(candidate?: string): string | undefined {
  if (!candidate) return;
  if (is_valid_uuid_string(candidate)) return candidate;
  const base = candidate.split(".")[0];
  return is_valid_uuid_string(base) ? base : undefined;
}

export function getIdentity({
  client = connectToConat(),
  project_id,
}: {
  client?: ConatClient;
  project_id?: string;
} = {}): {
  client: ConatClient;
  project_id: string;
} {
  const normalized = normalizeProjectId(project_id);
  if (!normalized) {
    const infoProjectId = normalizeProjectId(client.info?.user?.project_id);
    project_id = infoProjectId ?? data.project_id;
  } else {
    project_id = normalized;
  }
  return { client, project_id: project_id! };
}

export function connectToConat(
  options?: ClientOptions & {
    apiKey?: string;
    secretToken?: string;
    project_id?: string;
  },
): ConatClient {
  logger.debug("connectToConat");
  const apiKey = options?.apiKey ?? data.apiKey;
  const project_id =
    normalizeProjectId(options?.project_id) ?? data.project_id;
  const secretToken = options?.secretToken ?? data.secretToken;
  const address = options?.address ?? data.conatServer;

  let Cookie;
  if (apiKey) {
    Cookie = `${API_COOKIE_NAME}=${apiKey}`;
  } else if (secretToken) {
    Cookie = `${PROJECT_SECRET_COOKIE_NAME}=${secretToken}; ${PROJECT_ID_COOKIE_NAME}=${project_id}`;
  } else {
    Cookie = "";
  }
  const conn = connect({
    address,
    inboxPrefix: inboxPrefix({ project_id }),
    extraHeaders: { Cookie },
    ...options,
  });
  if (apiKey) {
    // we don't know the project_id that this apiKey provides access to. That
    // project_id is in info.user, which we only know after being authenticated
    // with the api key!
    conn.inboxPrefixHook = (info) => {
      return info?.user ? inboxPrefix(info?.user) : undefined;
    };
  }

  versionCheckLoop(conn);
  return conn;
}

export function init() {
  setConatClient({
    conat: connectToConat,
    project_id: data.project_id,
    getLogger,
  });
}
init();
