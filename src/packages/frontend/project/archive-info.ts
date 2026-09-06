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
  getBackupCoverage as getProjectBackupCoverage,
  getBackupAttempt as getProjectBackupAttempt,
  getBackupCoverageReportChunk as getProjectBackupCoverageReportChunk,
  getSnapshotFileText as getProjectSnapshotFileText,
} from "@cocalc/conat/project/archive-info";
import type {
  BackupFindPreview,
  BackupFindResult,
} from "@cocalc/conat/project/archive-info";
import { webapp_client } from "@cocalc/frontend/webapp-client";

async function getClient({
  client,
  project_id,
  caller,
}: {
  client?: ConatClient;
  project_id: string;
  caller: string;
}): Promise<ConatClient> {
  return (
    client ??
    (await webapp_client.conat_client.projectConat({
      project_id,
      caller,
    }))
  );
}

export async function getBackupAttempt({
  client,
  project_id,
}: {
  client?: ConatClient;
  project_id: string;
}) {
  return await getProjectBackupAttempt({
    project_id,
    client: await getClient({ client, project_id, caller: "getBackupAttempt" }),
  });
}

export async function getBackupCoverage({
  client,
  ...opts
}: {
  client?: ConatClient;
  project_id: string;
  backup_id?: string;
  cursor?: string | null;
  acknowledgement_keys?: string[];
}) {
  return await getProjectBackupCoverage({
    ...opts,
    client: await getClient({
      client,
      project_id: opts.project_id,
      caller: "getBackupCoverage",
    }),
  });
}

export async function getBackupCoverageReportChunk({
  client,
  ...opts
}: {
  client?: ConatClient;
  project_id: string;
  backup_id: string;
  offset: number;
}) {
  return await getProjectBackupCoverageReportChunk({
    ...opts,
    client: await getClient({
      client,
      project_id: opts.project_id,
      caller: "getBackupCoverageReportChunk",
    }),
  });
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
    client: await getClient({
      client,
      project_id: opts.project_id,
      caller: "getBackups",
    }),
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
    client: await getClient({
      client,
      project_id: opts.project_id,
      caller: "getBackupFiles",
    }),
    ...opts,
  });
}

type FindBackupFilesOptions = {
  client?: ConatClient;
  project_id: string;
  glob?: string[];
  iglob?: string[];
  path?: string;
  ids?: string[];
  recursive?: boolean;
};

export async function findBackupFiles(
  opts: FindBackupFilesOptions & { preview: true },
): Promise<BackupFindPreview>;
export async function findBackupFiles(
  opts: FindBackupFilesOptions & { preview?: false },
): Promise<BackupFindResult[]>;
export async function findBackupFiles({
  client,
  ...opts
}: FindBackupFilesOptions & { preview?: boolean }): Promise<
  BackupFindResult[] | BackupFindPreview
> {
  const request = {
    client: await getClient({
      client,
      project_id: opts.project_id,
      caller: "findBackupFiles",
    }),
    ...opts,
  };
  if (opts.preview) {
    return await findProjectBackupFiles({ ...request, preview: true });
  }
  return await findProjectBackupFiles({ ...request, preview: false });
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
    client: await getClient({
      client,
      project_id: opts.project_id,
      caller: "getBackupFileText",
    }),
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
    client: await getClient({
      client,
      project_id: opts.project_id,
      caller: "getSnapshotFileText",
    }),
    ...opts,
  });
}
