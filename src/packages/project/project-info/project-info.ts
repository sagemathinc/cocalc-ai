/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Project information
*/

import { ProjectInfoServer } from "./server";
import { createService } from "@cocalc/conat/project/project-info";
import { project_id } from "@cocalc/project/data";
import type { Client as ConatClient } from "@cocalc/conat/core/client";

// singleton, we instantiate it when we need it
let info: ProjectInfoServer | null = null;
let service: any = null;

export function get_ProjectInfoServer(opts?: {
  client?: ConatClient;
  project_id?: string;
}): ProjectInfoServer {
  if (info != null) {
    return info;
  }
  info = new ProjectInfoServer();
  service = createService({
    infoServer: info,
    project_id: opts?.project_id ?? project_id,
    client: opts?.client,
  });

  return info;
}

export function close() {
  service?.close();
  info?.close();
  info = service = null;
}
