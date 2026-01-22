//########################################################################
// This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
// License: MS-RSL – see LICENSE.md for details
//########################################################################

/*
Access permissions related to projects for a given user (or project).
*/

import { callback2 } from "@cocalc/util/async-utils";
import { defaults, required, to_json } from "@cocalc/util/misc";
import { getLogger } from "./logger";

const logger = getLogger("access");

interface AccessOpts {
  project_id: string;
  account_id?: string;
  account_groups?: string[];
  groups?: string[];
  database: any;
  cb: (err?: any, access?: boolean) => void;
}

function user_is_in_project_group(rawOpts: AccessOpts): void {
  const opts = defaults(rawOpts, {
    project_id: required,
    account_id: undefined,
    account_groups: undefined,
    groups: required,
    database: required,
    cb: required,
  }) as AccessOpts;

  const dbg = (m?: string) =>
    logger.debug(`user_is_in_project_group -- ${m ?? ""}`);
  dbg();

  if (!opts.account_id) {
    dbg("not logged in, so for now we just say 'no' -- this may change soon.");
    opts.cb(undefined, false);
    return;
  }

  if (opts.account_id === opts.project_id) {
    // Special case, e.g., project accessing "itself" for a project API key.
    opts.cb(undefined, true);
    return;
  }

  (async () => {
    let access = false;

    dbg(
      `check if admin or in appropriate group -- ${to_json(
        opts.account_groups,
      )}`,
    );

    if (Array.isArray(opts.account_groups) && opts.account_groups.includes("admin")) {
      access = true;
    } else {
      access = !!(await callback2(opts.database.user_is_in_project_group, {
        project_id: opts.project_id,
        account_id: opts.account_id,
        groups: opts.groups,
      }));
    }

    if (!access && !opts.account_groups) {
      const r = await callback2(opts.database.get_account, {
        columns: ["groups"],
        account_id: opts.account_id,
      });
      access = Array.isArray(r?.groups) && r.groups.includes("admin");
    }

    dbg(`done with tests -- now access=${access}, err=undefined`);
    return access;
  })()
    .then((access) => opts.cb(undefined, access))
    .catch((err) => {
      dbg(`done with tests -- now access=false, err=${err}`);
      opts.cb(err);
    });
}

export function user_has_write_access_to_project(opts: AccessOpts): void {
  opts.groups = ["owner", "collaborator"];
  user_is_in_project_group(opts);
}

export function user_has_read_access_to_project(opts: AccessOpts): void {
  opts.groups = ["owner", "collaborator", "viewer"];
  user_is_in_project_group(opts);
}
