//########################################################################
// This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
// License: MS-RSL – see LICENSE.md for details
//########################################################################

/*
Blobs
*/

import { getLogger } from "./logger";
import { defaults, required, human_readable_size } from "@cocalc/util/misc";
import { uuidsha1 } from "@cocalc/backend/misc_node";
import { MAX_BLOB_SIZE } from "@cocalc/util/db-schema/blobs";

const logger = getLogger("blobs");

interface SaveBlobOpts {
  uuid?: string;
  blob?: Buffer;
  ttl?: number;
  check?: boolean;
  project_id?: string;
  account_id?: string;
  database: any;
  cb: (err?: any, ttl?: number) => void;
}

// Save a blob in the blobstore database with given uuidsha1 hash.
export function save_blob(rawOpts: SaveBlobOpts): void {
  const opts = defaults(rawOpts, {
    uuid: undefined,
    blob: undefined,
    ttl: undefined,
    check: true,
    project_id: undefined,
    account_id: undefined,
    database: required,
    cb: required,
  }) as SaveBlobOpts;

  const dbg = (m: string) =>
    logger.debug(`save_blob(uuid=${opts.uuid}): ${m}`);
  dbg("");

  let err: string | undefined;
  const blobLength = opts.blob?.length ?? 0;

  if (!opts.blob) {
    err = `save_blob: UG -- error in call to save_blob (uuid=${opts.uuid}); received a save_blob request with undefined blob`;
  } else if (!opts.uuid) {
    err =
      "save_blob: BUG -- error in call to save_blob; received a save_blob request without corresponding uuid";
  } else if (!opts.project_id) {
    err =
      "save_blob: BUG -- error in call to save_blob; received a save_blob request without corresponding project_id";
  } else if (blobLength > MAX_BLOB_SIZE) {
    err = `save_blob: blobs are limited to ${human_readable_size(
      MAX_BLOB_SIZE,
    )} and you just tried to save one of size ${blobLength / 1000000}MB`;
  } else if (opts.check && opts.uuid !== uuidsha1(opts.blob)) {
    err = `save_blob: uuid=${opts.uuid} must be derived from the Sha1 hash of blob, but it is not (possible malicious attack)`;
  }

  if (err) {
    dbg(err);
    opts.cb(err);
    return;
  }

  // Store the blob in the database, if it isn't there already.
  opts.database.save_blob({
    uuid: opts.uuid,
    blob: opts.blob,
    ttl: opts.ttl,
    project_id: opts.project_id,
    account_id: opts.account_id,
    cb: (error, ttl) => {
      if (error) {
        dbg(`failed to store blob -- ${error}`);
      } else {
        dbg("successfully stored blob");
      }
      opts.cb(error, ttl);
    },
  });
}
