/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { once } from "@cocalc/util/async-utils";
import { synctable_no_changefeed } from "../synctable-no-changefeed";

class TestClient extends EventEmitter {
  public readonly queries: any[] = [];

  is_project = () => false;
  is_browser = () => true;
  is_connected = () => true;
  is_signed_in = () => true;
  server_time = () => new Date();
  dbg =
    (_s: string) =>
    (..._args) => {};
  touch_project = async (_project_id: string) => {};
  alert_message = (_opts) => {};
  is_deleted = (_path: string, _project_id: string) => undefined;

  query = (opts) => {
    this.queries.push(opts);
    opts.cb(undefined, {
      query: {
        accounts: [
          {
            account_id: "11111111-1111-4111-8111-111111111111",
            first_name: "Ada",
          },
        ],
      },
    });
  };

  query_cancel = (_id) => {};
}

describe("synctable_no_changefeed", () => {
  it("initializes with a snapshot query instead of a live changefeed", async () => {
    const client = new TestClient();
    const table = synctable_no_changefeed(
      {
        accounts: [
          {
            account_id: null,
            first_name: null,
          },
        ],
      },
      [],
      client as any,
      undefined,
    );

    await once(table, "connected");

    expect(client.queries).toHaveLength(1);
    expect(client.queries[0].changes).toBe(false);
    expect(table.get_one()?.toJS()).toEqual({
      account_id: "11111111-1111-4111-8111-111111111111",
      first_name: "Ada",
    });

    table.close();
    await once(table, "closed");
    expect(client.listenerCount("connected")).toBe(0);
    expect(client.listenerCount("signed_in")).toBe(0);
  });
});
