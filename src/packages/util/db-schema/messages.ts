/*
 *  This file is part of CoCalc: Copyright © 2020-2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
This table stores legacy internal messages that are still used by server-side
system, billing, admin, and course/organization workflows.

Browser/API clients must not create messages through user_query. The old
user-to-user message composer was removed because it was no longer a core
product surface and exposed avoidable abuse/spam paths.
*/

import { isValidUUID } from "@cocalc/util/misc";

import { ID } from "./crm";
import { SCHEMA } from "./index";
import { Table } from "./types";

type DbClient = {
  query: (...args: any[]) => Promise<any>;
  release: () => void;
};

// make this a bit big initially -- we'll add a feature to "load more", hopefully before
// this limit is a problem
export const NUM_MESSAGES = 1000;

interface Message0 {
  id: number;
  from_id: string; // a uuid
  to_ids: string[]; // array of uuid's
  subject: string;
  body: string;
  system_notice?: boolean;
  // sent is only set after message is sent.
  sent?: Date;
  // used for replies
  thread_id?: number;

  // optionally included mainly in frontend code when working with a list of messages
  // not in database!
  index?: number;
}

export const NON_BITSET_FIELDS = [
  "id",
  "subject",
  "body",
  "from_id",
  "to_ids",
  "system_notice",
  "sent",
  "thread_id",
];

export interface Message extends Message0 {
  read?: string;
  saved?: string;
  starred?: string;
  deleted?: string;
  expire?: string;
}

export interface MessageMe extends Message0 {
  read?: boolean;
  saved?: boolean;
  starred?: boolean;
  liked?: boolean;
  deleted?: boolean;
  expire?: boolean;
}

export const MAX_LIMIT = 500;

export const BITSET_FIELDS = [
  "read",
  "saved",
  "starred",
  "liked",
  "deleted",
  "expire",
] as const;

export type BitSetField = (typeof BITSET_FIELDS)[number];

export function isBitSetField(x): x is BitSetField {
  return typeof x == "string" && BITSET_FIELDS.includes(x as any);
}

export interface ApiMessagesGet {
  account_id: string;
  limit?: number;
  offset?: number;
  // received = all messages to you (the default)
  // sent = all messages you sent
  // new = to you and not read or saved -- these are what the counter counts
  type?: "received" | "sent" | "new" | "starred" | "liked";
  // strictly newer than cutoff
  cutoff?: Date;
}

export function getBitPosition({
  account_id,
  to_ids,
  from_id,
}: {
  account_id: string;
  to_ids;
  from_id: string;
}): number {
  const i = to_ids.indexOf(account_id);
  if (i != -1) {
    return i + 1;
  }
  if (account_id == from_id) {
    return 0;
  }
  throw Error(
    `invalid user -- ${account_id}, to_ids=${JSON.stringify(to_ids)}, from_id=${from_id}`,
  );
}

Table({
  name: "messages",
  fields: {
    id: ID,
    sent: {
      type: "timestamp",
      desc: "When this message was actually sent.  A draft is a message where sent has not yet been set.",
    },
    from_id: {
      type: "uuid",
      desc: "A project_id when from='project' and an account_id when from='account'.  For type='system', haven't decided what this is yet (maybe some hardcoded uuid's for different components of the system?).",
      not_null: true,
      render: { type: "account" },
    },
    to_ids: {
      type: "array",
      pg_type: "UUID[]",
      desc: "array of uuid's of account that the message is being sent to",
      not_null: true,
      render: { type: "accounts" },
    },
    subject: {
      type: "string",
      desc: "Subject of the message.",
      not_null: true,
    },
    body: {
      type: "string",
      desc: "Body of the message (should be formatted as markdown).",
      not_null: true,
    },
    system_notice: {
      type: "boolean",
      desc: "True exactly for system-generated notices that should be surfaced as notifications rather than in the legacy inbox.",
    },
    thread_id: {
      type: "number",
      desc: "If this message is in a thread, this is the id of the root message.",
    },
    // The rest are status bitsets, with bit 0 corresponds to from_id, and bits 1 to n corresponding
    // the users receiving the message, according to the ids in to_ids.
    read: {
      type: "string",
      pg_type: "bit varying",
      desc: "User read this message.",
    },
    saved: {
      type: "string",
      pg_type: "bit varying",
      desc: "Users that saved this message for later (so no longer in inbox)",
    },
    starred: {
      type: "string",
      pg_type: "bit varying",
      desc: "Users that starred this message so they can easily find it later",
    },
    liked: {
      type: "string",
      pg_type: "bit varying",
      desc: "Users liked this message, indicate to sender and other uses that is good. Thumbs up.",
    },
    deleted: {
      type: "string",
      pg_type: "bit varying",
      desc: "If user deleted this message (so in the trash).",
    },
    expire: {
      type: "string",
      pg_type: "bit varying",
      desc: "User permanently deleted this message. ",
    },
  },
  rules: {
    primary_key: "id",
    changefeed_keys: ["to_ids", "sent"],
    pg_indexes: ["USING GIN (to_ids)", "sent"],
    user_query: {
      get: {
        pg_where: [
          { "$::UUID = ANY(to_ids)": "account_id" },
          "sent IS NOT null",
          "COALESCE(system_notice, FALSE) IS NOT TRUE",
        ],
        options: [{ order_by: "-id" }, { limit: NUM_MESSAGES }],
        fields: {
          id: null,
          sent: null,
          from_id: null,
          to_ids: null,
          subject: null,
          body: null,
          system_notice: null,
          thread_id: null,
          read: null,
          saved: null,
          starred: null,
          liked: null,
          deleted: null,
          expire: null,
        },
      },
      set: {
        fields: {
          id: true,
          read: true,
          saved: true,
          starred: true,
          liked: true,
          deleted: true,
          expire: true,
        },
        async instead_of_change(
          database,
          old_val,
          new_val,
          account_id,
          cb,
        ): Promise<void> {
          let client: DbClient | undefined;
          try {
            client = await database._get_query_client();
          } catch (err) {
            cb("database not connected -- try again later");
            return;
          }
          if (!client) {
            cb("database not connected -- try again later");
            return;
          }
          try {
            if (old_val != null) {
              // const dbg = database._dbg("messages:instead_of_change");

              // It took me a long time to figure out that this is the way to flip bits without changing what is there, which
              // we need to do in order avoid a race condition, where two users say both mark a message read at almost the
              // same time, and they both write out 01 and 10 for the read bitset... with last write wins, the database would
              // end up with either 01 or 10, and one person's value is lost.  That's sill. With just directly changing *only*
              // the user's bit, we always end up with 11.  And this code illustrates how to change one bit.  Here "20" is
              // the number of users (so number of recipients + 1), and 3 is the position to flip (+1 since it is 1-indexed in postgres),
              // and it's `'x'::bit(1),3+1` to set the bit to x (=0 or 1), i.e., 0 in this example:
              //
              // smc=# update messages set saved=overlay(coalesce(saved,'0'::bit(1))::bit(20) PLACING '0'::bit(1) FROM 3+1) where id=61; select saved from messages where id=61;

              const ids = new_val.to_ids ?? old_val.to_ids ?? [];
              const numUsers = ids.length + 1;
              let userIndex = -1;
              const setBit = (field: BitSetField, value: string) => {
                if (userIndex == -1) {
                  // compute it first time, if needed
                  const n = ids.indexOf(account_id);
                  if (n == -1) {
                    throw Error(
                      "you do not have permission to edit this message",
                    );
                  }
                  userIndex = n + 1; // +1 to account for from_id
                }
                // ignore everything in value except the userIndex position.
                const bit = value[userIndex] ?? "0";
                if (bit != "0" && bit != "1") {
                  // be especially careful to avoid sql injection attack.
                  throw Error(`invalid bit '${bit}'`);
                }
                return `${field} = overlay(coalesce(${field},'0'::bit(1))::bit(${numUsers}) PLACING '${bit}'::bit(1) FROM ${userIndex}+1)`;
              };

              const v: string[] = [];
              for (const field of BITSET_FIELDS) {
                if (
                  new_val[field] != null &&
                  new_val[field] != old_val[field]
                ) {
                  v.push(setBit(field, new_val[field]));
                }
              }

              if (v.length == 0) {
                // nothing changed
                cb();
                return;
              }

              try {
                const query = `UPDATE messages SET ${v.join(",")}  WHERE $1=ANY(to_ids) AND id=$2`;
                const params = [account_id, parseInt(old_val.id)];
                await client.query(query, params);
                await database.updateUnreadMessageCount({ account_id });
                cb();
              } catch (err) {
                cb(`${err}`);
              }
            } else {
              cb("message creation via user_query is disabled");
            }
          } finally {
            client?.release();
          }
        },
      },
    },
  },
});

Table({
  name: "crm_messages",
  rules: {
    virtual: "messages",
    primary_key: "id",
    user_query: {
      get: {
        admin: true, // only admins can do get queries on this table
        fields: SCHEMA.messages.user_query?.get?.fields ?? {},
      },
    },
  },
  fields: SCHEMA.messages.fields,
});

// Helper function for database queries.

export function pgBitField(
  field: BitSetField,
  account_id: string,
  as?: string,
) {
  // be extra careful due to possibility of SQL injection.
  if (!isBitSetField(field)) {
    throw Error(`field ${field} must be a bitset field`);
  }
  if (!isValidUUID(account_id)) {
    throw Error("account_id must be valid");
  }
  if (as == null) {
    as = ` AS ${field}`;
  } else if (as) {
    as = ` AS ${as}`;
  }
  return `coalesce(substring(${field},array_position(to_ids,'${account_id}')+1,1),'0'::bit(1)) = '1'::bit(1) ${as}`;
}

export function pgBitFieldSelf(field: BitSetField, as?: string) {
  // be extra careful due to possibility of SQL injection.
  if (!isBitSetField(field)) {
    throw Error(`field ${field} must be a bitset field`);
  }
  if (as == null) {
    as = ` AS ${field}`;
  } else if (as) {
    as = ` AS ${as}`;
  }
  return `coalesce(substring(${field},1,1),'0'::bit(1)) = '1'::bit(1) ${as}`;
}
