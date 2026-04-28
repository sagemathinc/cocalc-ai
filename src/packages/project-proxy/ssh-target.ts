/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isValidUUID } from "@cocalc/util/misc";

export type SshTarget = { type: "project"; project_id: string };

/*
The patterns that we support here:

- project-{uuid} --> project_id={uuid}
- {uuid} --> project_id={uuid}
- {uuid with dashes removed} --> project_id={uuid with dashes put back}
*/
export function parseSshTargetUser(user: string): SshTarget {
  let prefix;
  if (user?.startsWith("project-")) {
    prefix = "project-";
  } else if (isValidUUID(user)) {
    prefix = "";
  } else if (
    user.length >= 32 &&
    isValidUUID(putBackDashes(user.split("-")[0]))
  ) {
    const v = user.split("-");
    return { type: "project", project_id: putBackDashes(v[0]) };
  } else {
    throw Error(`unknown user ${user}`);
  }

  return {
    type: "project",
    project_id: user.slice(prefix.length, prefix.length + 36),
  };
}

// 00000000-1000-4000-8000-000000000000
export function putBackDashes(s: string) {
  if (s.length != 32) {
    throw Error("must have length 32");
  }
  return (
    s.slice(0, 8) +
    "-" +
    s.slice(8, 12) +
    "-" +
    s.slice(12, 16) +
    "-" +
    s.slice(16, 20) +
    "-" +
    s.slice(20)
  );
}
