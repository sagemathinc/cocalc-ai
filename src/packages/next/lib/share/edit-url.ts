/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { join } from "path";
import ROOT_PATH from "lib/root-path";

interface CollaboratorOptions {
  project_id: string;
  path?: string; // no path means link to project
  relativePath?: string;
  type?: "collaborator";
}

type Options = CollaboratorOptions;

export default function editURL(options: Options): string {
  const type = options["type"];
  switch (type) {
    case "collaborator":
    default:
      return collaboratorURL(options);
  }
}

// needed since we're making a link outside of the nextjs server.
function withBasePath(url: string): string {
  return join(ROOT_PATH, url);
}

function collaboratorURL({
  project_id,
  path,
  relativePath,
}: {
  project_id: string;
  path?: string;
  relativePath?: string;
}): string {
  const projectURL = join("/projects", project_id);
  if (!path) {
    return withBasePath(projectURL);
  }
  return withBasePath(join(projectURL, "files", path, relativePath ?? ""));
}
