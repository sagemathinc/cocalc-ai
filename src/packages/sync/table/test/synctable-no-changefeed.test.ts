/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { once } from "@cocalc/util/async-utils";
import { synctable_no_changefeed } from "../synctable-no-changefeed";
import { ClientTest } from "./client-test";

describe("synctable_no_changefeed", () => {
  const notifications = [
    {
      id: "123e4567-e89b-12d3-a456-426655440000",
      time: new Date(),
      text: "This is a message.",
      priority: "low",
    },
  ];
  const query = {
    system_notifications: [
      { id: null, time: null, text: null, priority: null },
    ],
  };

  test("does not try to bootstrap a browser changefeed before account id exists", async () => {
    const client = new ClientTest(notifications) as ClientTest & {
      client_id: () => string | undefined;
      getConatClient: () => never;
    };
    client.client_id = () => undefined;
    client.getConatClient = () => {
      throw new Error("should not ask for a conat client");
    };

    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const table = synctable_no_changefeed(query, [], client, 0);
    try {
      await once(table, "connected");
      expect(table.get_state()).toBe("connected");
      expect(log).not.toHaveBeenCalledWith(
        expect.stringContaining(
          "waiting for valid account id before creating changefeed",
        ),
      );
    } finally {
      log.mockRestore();
      table.close();
      await once(table, "closed");
    }
  });
});
