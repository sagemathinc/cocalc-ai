/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    silly: jest.fn(),
  }),
}));

import { delay } from "awaiting";
import { Client, connect } from "./client";
import { ConatServer, init } from "./server";
import { createServiceClient, createServiceHandler } from "../service/typed";

describe("authenticated Conat caller metadata", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  it.each(["fast-rpc", "request"] as const)(
    "binds source bay claims over %s",
    async (transport) => {
      const server = init({
        port: 0,
        getUser: async (socket) => socket.handshake.auth,
        isAllowed: async () => true,
      });
      const serviceClient = connect({
        address: server.address(),
        noCache: true,
        auth: { hub_id: "service" },
      });
      const callerClient = connect({
        address: server.address(),
        noCache: true,
        auth: {
          hub_id: "bay:bay-authenticated",
          cluster_id: "cluster",
          bay_id: "bay-authenticated",
          bay_credential_id: "credential",
        },
      });
      await Promise.all([
        serviceClient.waitUntilSignedIn({ timeout: 5_000 }),
        callerClient.waitUntilSignedIn({ timeout: 5_000 }),
      ]);
      const impl = jest.fn(async () => "ok");
      const service = createServiceHandler<any>({
        service: "caller-test",
        subject: `caller.test.${transport}`,
        transport,
        client: serviceClient,
        impl: { write: impl },
      });
      await delay(50);
      const api = createServiceClient<any>({
        service: "caller-test",
        subject: `caller.test.${transport}`,
        transport,
        client: callerClient,
      });

      await expect(api.write({ source_bay_id: "bay-spoofed" })).rejects.toThrow(
        "must match authenticated bay 'bay-authenticated'",
      );
      await expect(
        api.write({ source_bay_id: "bay-authenticated" }),
      ).resolves.toBe("ok");
      expect(impl).toHaveBeenCalledTimes(1);

      service.close();
      callerClient.close();
      serviceClient.close();
      await server.close();
    },
  );
});
