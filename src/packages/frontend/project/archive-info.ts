/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client as ConatClient } from "@cocalc/conat/core/client";
import {
  findBackupFiles as findProjectBackupFiles,
  getBackupFileText as getProjectBackupFileText,
  getBackupFiles as getProjectBackupFiles,
  getBackups as getProjectBackups,
  getSnapshotFileText as getProjectSnapshotFileText,
} from "@cocalc/conat/project/archive-info";
import { webapp_client } from "@cocalc/frontend/webapp-client";

function getClient(client?: ConatClient): ConatClient {
  return client ?? webapp_client.conat_client.conat();
}

export async function getBackups({
  client,
  ...opts
}: {
  client?: ConatClient;
  project_id: string;
  indexed_only?: boolean;
}) {
  return await getProjectBackups({
    client: getClient(client),
    ...opts,
  });
}

export async function getBackupFiles({
  client,
  ...opts
}: {
  client?: ConatClient;
  project_id: string;
  id: string;
  path?: string;
}) {
  return await getProjectBackupFiles({
    client: getClient(client),
    ...opts,
  });
}

export async function findBackupFiles({
  client,
  ...opts
}: {
  client?: ConatClient;
  project_id: string;
  glob?: string[];
  iglob?: string[];
  path?: string;
  ids?: string[];
}) {
  return await findProjectBackupFiles({
    client: getClient(client),
    ...opts,
  });
}

export async function getBackupFileText({
  client,
  ...opts
}: {
  client?: ConatClient;
  project_id: string;
  id: string;
  path: string;
  max_bytes?: number;
}) {
  return await getProjectBackupFileText({
    client: getClient(client),
    ...opts,
  });
}

export async function getSnapshotFileText({
  client,
  ...opts
}: {
  client?: ConatClient;
  project_id: string;
  snapshot: string;
  path: string;
  max_bytes?: number;
}) {
  return await getProjectSnapshotFileText({
    client: getClient(client),
    ...opts,
  });
}
