/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createHostControlClient,
  type HostControlApi,
} from "@cocalc/conat/project-host/api";
import { getExplicitHostRoutedClient } from "@cocalc/server/conat/route-client";

export async function getRoutedHostControlClient({
  host_id,
  timeout,
  fresh = false,
}: {
  host_id: string;
  timeout?: number;
  fresh?: boolean;
}): Promise<HostControlApi> {
  return createHostControlClient({
    host_id,
    client: await getExplicitHostRoutedClient({ host_id, fresh }),
    timeout,
  });
}
