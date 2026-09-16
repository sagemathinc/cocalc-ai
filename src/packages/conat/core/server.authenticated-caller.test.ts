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
import {
  CLUSTER_INTEREST_OPEN,
  CLUSTER_INTEREST_PROTOCOL,
  CLUSTER_LINK_COOKIE_NAME,
} from "./cluster";
import {
  ConatServer,
  init,
  type AllowFunction,
  type UserFunction,
} from "./server";
import { createServiceClient, createServiceHandler } from "../service/typed";

describe("authenticated Conat caller metadata", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  it("requires a distinct link credential for authenticated clusters", () => {
    expect(() =>
      init({
        id: "authenticated",
        port: 0,
        clusterName: "credential-boundary",
        getUser: async () => ({ hub_id: "test" }),
      }),
    ).toThrow("authenticated cluster must have clusterLinkPassword set");
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

  it("preserves authenticated bay identity across a distinct cluster link", async () => {
    const clusterLinkPassword = "cluster-link-secret";
    const getUser: UserFunction = async (socket: any, systemAccounts = {}) => {
      const cookie = `${socket.handshake.headers.cookie ?? ""}`;
      for (const [name, account] of Object.entries(systemAccounts)) {
        if (cookie.includes(`${name}=${account.password}`)) {
          return account.user;
        }
      }
      return socket.handshake.auth;
    };
    const forwarded: any[] = [];
    const isAllowed: AllowFunction = async (opts) => {
      if (opts.user?.hub_id === "cluster-link") {
        if (opts.type === "sub") {
          return opts.subject.startsWith("_INBOX.");
        }
        forwarded.push(opts);
        if (!opts.subject.startsWith("global.directory.rpc.")) {
          return true;
        }
        return (
          opts.type === "pub" &&
          opts.forwardedCaller?.bay_id === "bay-authenticated"
        );
      }
      return true;
    };
    const common = {
      clusterName: "caller-cluster",
      systemAccountPassword: "generic-system-secret",
      clusterLinkPassword,
      autoscanInterval: 0,
      getUser,
      isAllowed,
    };
    const sourceServer = init({ ...common, id: "source", port: 0 });
    const targetServer = init({ ...common, id: "target", port: 0 });
    const serviceClient = connect({
      address: targetServer.address(),
      noCache: true,
      auth: { hub_id: "service" },
    });
    const callerClient = connect({
      address: sourceServer.address(),
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
    const genericSystemClient = connect({
      address: targetServer.address(),
      noCache: true,
      systemAccountPassword: "generic-system-secret",
    });
    await genericSystemClient.waitUntilSignedIn({ timeout: 5_000 });
    const systemOpen = await new Promise<any>((resolve) => {
      genericSystemClient.conn.emit(
        CLUSTER_INTEREST_OPEN,
        {
          protocol: CLUSTER_INTEREST_PROTOCOL,
          clusterName: "caller-cluster",
          nodeId: "forged-system-link",
        },
        resolve,
      );
    });
    expect(systemOpen).toEqual(
      expect.objectContaining({ ok: false, code: 403 }),
    );
    genericSystemClient.close();

    const directClusterLink = connect({
      address: targetServer.address(),
      noCache: true,
      extraHeaders: {
        Cookie: `${CLUSTER_LINK_COOKIE_NAME}=${clusterLinkPassword}`,
      },
    });
    await directClusterLink.waitUntilSignedIn({ timeout: 5_000 });
    const directPublish = await new Promise<any>((resolve) => {
      directClusterLink.conn.emit(
        "publish",
        ["global.directory.rpc.cluster-test"],
        resolve,
      );
    });
    expect(directPublish).toEqual(expect.objectContaining({ code: 403 }));
    directClusterLink.close();

    const impl = jest.fn(async () => "ok");
    const service = createServiceHandler<any>({
      service: "caller-test",
      subject: "global.directory.rpc.cluster-test",
      transport: "request",
      client: serviceClient,
      impl: { write: impl },
    });
    await delay(50);
    await Promise.all([
      sourceServer.join(targetServer.address(), { timeout: 5_000 }),
      targetServer.join(sourceServer.address(), { timeout: 5_000 }),
    ]);
    await delay(50);
    const api = createServiceClient<any>({
      service: "caller-test",
      subject: "global.directory.rpc.cluster-test",
      transport: "request",
      client: callerClient,
    });

    await expect(
      api.write({ source_bay_id: "bay-authenticated" }),
    ).resolves.toBe("ok");
    expect(impl).toHaveBeenCalledTimes(1);
    expect(forwarded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: "global.directory.rpc.cluster-test",
          forwardedCaller: {
            cluster_id: "cluster",
            bay_id: "bay-authenticated",
            bay_credential_id: "credential",
          },
        }),
      ]),
    );

    service.close();
    callerClient.close();
    serviceClient.close();
    await sourceServer.close();
    await targetServer.close();
  }, 15_000);
});
