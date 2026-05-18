/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

/*
Tracking web-analytics
this records data about users hitting cocalc and cocalc-related websites
this table is 100% back-end only.
*/
Table({
  name: "analytics",
  rules: {
    primary_key: ["token"],
    pg_indexes: ["token", "data_time"],
    durability: "soft",
    user_query: {
      get: {
        pg_where: [],
        admin: true,
        fields: {
          token: null,
          data: null,
          data_time: null,
          account_id: null,
          account_id_time: null,
          expire: null,
        },
      },
    },
  },
  fields: {
    token: {
      type: "uuid",
    },
    data: {
      type: "map",
      desc: "referrer, landing page, utm, etc.",
    },
    data_time: {
      type: "timestamp",
      desc: "when the data field was set",
    },
    account_id: {
      type: "uuid",
      desc: "set only once, when the user (eventually) signs in",
    },
    account_id_time: {
      type: "timestamp",
      desc: "when the account id was set",
    },
    expire: {
      type: "timestamp",
      desc: "future date, when the entry will be deleted",
    },
  },
});
