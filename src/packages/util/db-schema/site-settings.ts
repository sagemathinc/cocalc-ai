/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// These site-settings are visible to any user (read-only)
// They contain information like the site's name, contact email addresses, etc.

import { site_settings_conf } from "./site-defaults";
import { EXTRAS as site_settings_extras } from "./site-settings-extras";
import { isSecretSetting } from "../secret-settings";
import { keys } from "../misc";

const site_settings_fields = keys(site_settings_conf).concat(
  keys(site_settings_extras)
);

import { Table } from "./types";

async function instead_of_query(db, opts: any, cb: Function): Promise<void> {
  try {
    const requested = opts.query?.name;
    let names = site_settings_fields;
    if (typeof requested === "string") {
      names = [requested];
    } else if (Array.isArray(requested) && requested.length > 0) {
      names = requested;
    }
    db._query({
      query: "SELECT name, value, readonly FROM server_settings",
      where: { "name = ANY($)": names },
      cb: (err, result) => {
        if (err) {
          cb(err);
          return;
        }
        const rows = result.rows ?? [];
        const data = rows.map((row) => {
          const secret = isSecretSetting(row.name);
          const value = row.value ?? "";
          return {
            name: row.name,
            value: secret ? "" : value,
            readonly: row.readonly ?? false,
            is_set: secret ? value !== "" : false,
          };
        });
        cb(undefined, data);
      },
    });
  } catch (err) {
    cb(err);
  }
}

Table({
  name: "site_settings",
  rules: {
    virtual: "server_settings",
    anonymous: false,
    user_query: {
      // NOTE: can set and get only fields in site_settings_fields, but not any others.
      get: {
        instead_of_query,
        pg_where: [{ "name = ANY($)": site_settings_fields }],
        admin: true,
        fields: {
          name: null,
          value: null,
          readonly: null,
          is_set: null,
        },
      },
      set: {
        admin: true,
        fields: {
          name: null,
          value: null,
        },
        check_hook(db, obj, _account_id, _project_id, cb) {
          if (!site_settings_fields.includes(obj.name)) {
            cb(`setting name='${obj.name}' not allowed`);
            return;
          }
          db._query({
            query: "SELECT readonly FROM server_settings",
            where: { "name = $::TEXT": obj.name },
            cb: (err, result) => {
              if (err) {
                cb(err);
                return;
              }
              if (result.rows[0]?.readonly === true) {
                cb(`setting name='${obj.name}' is readonly`);
                return;
              }
              cb();
            },
          });
        },
      },
    },
  },
});
