/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The durability records' owner of a maintained database (finding 028 B-2,
// B2-M1; ops0 3587 and its tightening).  The catalog's LOGICAL path is
// primary: it is the exact key the open path uses (util.ts storeOwner: the
// project of the logical path, else "host").  The PHYSICAL path, inverted
// under the persist roots, is the fallback for a database the scanner found
// but no open has recorded.  When both give an owner they must agree; a
// disagreement, or no owner at all, refuses the maintenance open.

import { projectOfStoragePath } from "@cocalc/conat/persist/project-fence";
import { ownerOfLocalPath } from "@cocalc/conat/persist/util";

export type MaintenanceOwner = { owner: string } | { refused: string };

export function maintenanceOwner({
  logicalPath,
  physicalPath,
  files,
}: {
  logicalPath?: string;
  physicalPath: string;
  files: Parameters<typeof ownerOfLocalPath>[1];
}): MaintenanceOwner {
  const fromLogical = logicalPath
    ? (projectOfStoragePath(logicalPath) ?? "host")
    : undefined;
  const fromPhysical = ownerOfLocalPath(physicalPath, files);
  if (
    fromLogical != null &&
    fromPhysical != null &&
    fromLogical !== fromPhysical
  ) {
    return {
      refused: `the stream's owner is ambiguous: its logical path ${logicalPath} gives ${fromLogical}, its physical path ${physicalPath} gives ${fromPhysical}`,
    };
  }
  const owner = fromLogical ?? fromPhysical;
  if (owner == null) {
    return {
      refused: `the stream's owner can't be derived (no logical path, and the physical path ${physicalPath} is under no persist root)`,
    };
  }
  return { owner };
}
