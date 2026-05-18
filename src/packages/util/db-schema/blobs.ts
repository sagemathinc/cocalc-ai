/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";
import { isValidUUID } from "@cocalc/util/misc";

// Note that github has a 10MB limit --
//   https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files
// All code in cocalc (frontend, etc.) should use this,
// rather than copying or defining their own!
export const MAX_BLOB_SIZE = 25_000_000;

// some throttling -- note that after a bit, most blobs end up longterm
// cloud storage and are never accessed.  This is mainly a limit to
// prevent abuse.
export const MAX_BLOB_SIZE_PER_PROJECT_PER_DAY = {
  licensed: 100 * MAX_BLOB_SIZE,
  unlicensed: 10 * MAX_BLOB_SIZE,
};

type DbClient = {
  query: (...args: any[]) => Promise<any>;
  release: () => void;
};

async function assertCanReadBlob({
  database,
  uuid,
  account_id,
}: {
  database: any;
  uuid: string;
  account_id?: string;
}) {
  if (!account_id) {
    throw Error("you must be signed in");
  }
  if (!isValidUUID(uuid)) {
    throw Error("uuid is invalid");
  }
  let client: DbClient | undefined;
  try {
    client = await database._get_query_client();
    if (!client) {
      throw Error("database not connected -- try again later");
    }
    const { rows } = await client.query(
      `
        SELECT COALESCE(b.project_id, s.project_id::TEXT) AS project_id
          FROM blobs AS b
          LEFT JOIN syncstrings AS s ON s.archived = b.id
         WHERE b.id = $1::UUID
         LIMIT 1
      `,
      [uuid],
    );
    const project_id = rows[0]?.project_id;
    if (!project_id) {
      return;
    }
    const allowed = await client.query(
      `
        SELECT 1
          FROM projects
         WHERE project_id = $1::UUID
           AND COALESCE(deleted, FALSE) IS NOT TRUE
           AND (users -> $2::TEXT ->> 'group') IN ('owner', 'collaborator')
         LIMIT 1
      `,
      [project_id, account_id],
    );
    if (allowed.rows.length === 0) {
      throw Error("you do not have permission to read this project blob");
    }
  } finally {
    client?.release();
  }
}

Table({
  name: "blobs",
  fields: {
    id: {
      type: "uuid",
      desc: "The uuid of this blob, which is a uuid derived from the Sha1 hash of the blob content.",
    },
    blob: {
      type: "Buffer",
      desc: "The actual blob content",
    },
    expire: {
      type: "timestamp",
      desc: "When to expire this blob (when delete_expired is called on the database).",
    },
    created: {
      type: "timestamp",
      desc: "When the blob was created.",
    },
    project_id: {
      // I'm not really sure why we record a project associated to the blob, rather
      // than something else (e.g., account_id)-- update: added that.  However, it's useful for abuse, since
      // if abuse happened with a project, we could easily delete all corresponding blobs,
      // and also it's a good tag for throttling.
      type: "string",
      desc: "The uuid of the project that created the blob, if it is associated to a project.",
    },
    account_id: {
      type: "uuid",
      desc: "The uuid of the account that created the blob. (Only started recording in late 2024.  Will make it so a user can optionally delete any blobs associated to their account when deleting their account.)",
    },
    last_active: {
      type: "timestamp",
      desc: "When the blob was last pulled from the database.",
    },
    count: {
      type: "number",
      desc: "How many times the blob has been pulled from the database.",
    },
    size: {
      type: "number",
      desc: "The size in bytes of the blob.",
    },
    gcloud: {
      type: "string",
      desc: "name of a bucket that contains the actual blob, if available.",
    },
    backup: {
      type: "boolean",
      desc: "if true, then this blob was saved to an offsite backup",
    },
    compress: {
      type: "string",
      desc: "optional compression used: 'gzip' or 'zlib'",
    },
  },
  rules: {
    desc: "Table that stores blobs mainly generated as output of notebooks.",
    primary_key: "id",
    // these indices speed up the search been done in 'copy_all_blobs_to_gcloud'
    // less important to make this query fast, but we want to avoid thrashing cache
    pg_indexes: ["((expire IS NULL))", "((gcloud IS NULL))", "last_active"],
    user_query: {
      get: {
        async instead_of_query(database, opts, cb): Promise<void> {
          const obj: any = Object.assign({}, opts.query);
          if (obj == null || obj.id == null) {
            cb("id must be specified");
            return;
          }
          try {
            await assertCanReadBlob({
              database,
              uuid: obj.id,
              account_id: opts.account_id,
            });
          } catch (err) {
            cb(`${err}`);
            return;
          }
          database.get_blob({
            uuid: obj.id,
            cb(err, blob) {
              if (err) {
                cb(err);
              } else {
                cb(undefined, { id: obj.id, blob });
              }
            },
          });
        },
        fields: {
          id: null,
          blob: null,
        },
      },
      set: {
        // NOTE: we put "as any" for fields below because ttl is not an actual field but
        // it is allowed for set queries and determine the expire field.  I would rather
        // do this (which *is* supported by the backend) then not restrict the fields keys
        // for other schema entries.  Alternatively, we could have a special kind of field
        // above that is "virtual", but that requires writing more code in the backend. We'll
        // do that if necessary.
        fields: {
          id: true,
          blob: true,
          project_id: "project_write",
          account_id: "account_id",
          ttl: 0,
        } as any,
        required_fields: {
          id: true,
          blob: true,
        },
        async instead_of_change(
          _database,
          _old_value,
          _new_val,
          _account_id,
          cb,
        ): Promise<void> {
          cb(
            "direct blob table writes are disabled; use the /blobs upload endpoint or saveBlob RPC",
          );
        },
      },
    },
  },
});
