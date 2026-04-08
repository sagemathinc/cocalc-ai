/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ProjectControlMethod = "start";
export type DirectoryMethod = "resolve-project-bay" | "resolve-host-bay";

export function projectControlSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: ProjectControlMethod;
}): string {
  return `bay.${dest_bay}.rpc.project-control.${method}`;
}

export function directorySubject({
  method,
}: {
  method: DirectoryMethod;
}): string {
  return `global.directory.rpc.${method}`;
}
