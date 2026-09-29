jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    silly: jest.fn(),
  }),
}));

import { connect, Client } from "./client";
import { init, ConatServer } from "./server";

describe("publication at the lease teardown boundary", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  it.each(
    ["publish", "wait-for-interest", "rpc", "fast-rpc", "rpc-raw"].flatMap(
      (method) =>
        ["before", "during-allow", "during-deny", "permission"].map(
          (boundary) => [method, boundary],
        ),
    ),
  )(
    "%s classifies %s without retrying authorization",
    async (method, boundary) => {
      const user = {
        account_id: "lease-test",
        auth_lease_exp_s: Date.now() / 1000 + 60,
      };
      const subject = "test.lease-admission";
      let checks = 0;
      const server = init({
        port: 0,
        autoscanInterval: 0,
        getUser: async () => user,
        isAllowed: async ({ subject: target, type }) => {
          if (target !== subject || type !== "pub") return true;
          checks++;
          if (boundary.startsWith("during"))
            user.auth_lease_exp_s = Date.now() / 1000 - 1;
          return boundary === "during-allow";
        },
      });
      const client = connect({ address: server.address(), noCache: true });
      try {
        await client.waitUntilSignedIn({ timeout: 5000 });
        // Keep the original timer pending while advancing the authenticated deadline,
        // deterministically modeling a request processed before overdue timer teardown.
        if (boundary === "before")
          user.auth_lease_exp_s = Date.now() / 1000 - 1;
        const payload = { subject, requestId: "lease-test", timeout: 100 };
        let response: any;
        if (method === "rpc-raw") {
          response = await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(Error("no raw RPC response")),
              2000,
            );
            client.conn.once("rpc-raw-response", (value) => {
              clearTimeout(timer);
              resolve(value);
            });
            client.conn.emit(method, payload);
          });
        } else {
          response = await client.conn
            .timeout(2000)
            .emitWithAck(method, method === "publish" ? [subject] : payload);
        }
        expect(response.code).toBe(
          boundary === "permission" ? 403 : "CONNECTION_LOST",
        );
        expect(checks).toBe(boundary === "before" ? 0 : 1);
        if (boundary !== "permission")
          expect(response.error).toContain("lease expired");
      } finally {
        client.close();
        await server.close();
      }
    },
  );
});
