/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import path from "node:path";

import { projectRuntimePathForProcess } from "@cocalc/util/project-runtime";

export function projectFilePath(
  requestedPath: string,
  {
    home = process.env.HOME,
    platform = process.platform,
    runtimeHome = process.env.COCALC_RUNTIME_HOME,
  }: { home?: string; platform?: NodeJS.Platform; runtimeHome?: string } = {},
): string {
  if (!home) return requestedPath;
  if (platform !== "win32") {
    if (path.isAbsolute(requestedPath)) {
      // Workspace runtimes advertise a canonical home such as /home/user,
      // while the project process uses the real workspace directory as HOME.
      // Preserve unrelated absolute paths for VM and external runtimes.
      return (
        projectRuntimePathForProcess(requestedPath, {
          COCALC_RUNTIME_HOME: runtimeHome,
          HOME: home,
        }) ?? requestedPath
      );
    }
    return path.join(home, requestedPath);
  }

  if (
    /^[A-Za-z]:[\\/]/.test(requestedPath) ||
    requestedPath.startsWith("\\\\")
  ) {
    return path.win32.normalize(requestedPath);
  }
  const virtualPath = requestedPath.replaceAll("\\", "/");
  const homePrefix = "/home/user";
  const relative = path.posix
    .resolve(
      "/",
      virtualPath === homePrefix
        ? ""
        : virtualPath.startsWith(`${homePrefix}/`)
          ? virtualPath.slice(homePrefix.length + 1)
          : virtualPath,
    )
    .slice(1);
  return path.win32.join(home, ...relative.split("/").filter(Boolean));
}
