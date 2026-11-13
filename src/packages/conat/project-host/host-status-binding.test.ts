/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Finding 068: every host-status request acts for the host that sent it.  The
// conat server stamps the authenticated host's id into the caller (only on
// the host-status subject), and the service replaces any host_id in the
// request with it; a caller that is not a host is refused.

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
import { connect } from "../core/client";
import { ConatServer, init } from "../core/server";
import { DataEncoding } from "../core/codec";
import { createServiceClient } from "../service/typed";
import {
  bindHostStatusArgs,
  createHostStatusClient,
  createHostStatusService,
} from "./api";

const HOST_A = "00000000-0000-4000-8000-00000000000a";
const HOST_B = "00000000-0000-4000-8000-00000000000b";
const PROJECT = "00000000-0000-4000-8000-000000000001";

const METHODS: Array<[string, any]> = [
  ["reportProjectState", { project_id: PROJECT, state: "running" }],
  ["reportProjectProvisioned", { project_id: PROJECT, provisioned: false }],
  ["reportHostProvisionedInventory", { project_ids: [] }],
  ["syncAccountRevocations", {}],
  ["registerOnPremTunnel", { public_key: "ssh-ed25519 AAAA" }],
  ["syncComputerAccess", {}],
];

// Every path into the handler: fast-rpc (the default), the legacy service a
// "request" client reaches beside it, and a service built for "request" only.
const MODES = ["fast-rpc", "legacy", "request"] as const;
type Mode = (typeof MODES)[number];

function statusClient(client, mode: Mode): any {
  return mode === "fast-rpc"
    ? createHostStatusClient({ client })
    : createServiceClient({
        service: "project-host",
        subject: "project-hosts.status",
        client,
        transport: "request",
      });
}

describe("host-status requests are bound to the calling host (068)", () => {
  // The global test registries need COCALC_TEST_MODE, so close what each test
  // opened directly.
  const opened: Array<{ close: () => any }> = [];
  const transportEnv = process.env.COCALC_CONAT_SERVICE_TRANSPORT;
  afterEach(async () => {
    for (const x of opened.splice(0).reverse()) {
      await x.close();
    }
    if (transportEnv == null) {
      delete process.env.COCALC_CONAT_SERVICE_TRANSPORT;
    } else {
      process.env.COCALC_CONAT_SERVICE_TRANSPORT = transportEnv;
    }
  });

  async function setup(mode: Mode = "fast-rpc") {
    if (mode === "request") {
      process.env.COCALC_CONAT_SERVICE_TRANSPORT = "request";
    }
    const server: ConatServer = init({
      port: 0,
      getUser: async (socket) => socket.handshake.auth,
      isAllowed: async () => true,
    });
    const hub = connect({
      address: server.address(),
      noCache: true,
      auth: { hub_id: "service" },
    });
    const hostA = connect({
      address: server.address(),
      noCache: true,
      auth: { host_id: HOST_A },
    });
    const account = connect({
      address: server.address(),
      noCache: true,
      auth: { account_id: "00000000-0000-4000-8000-0000000000cc" },
    });
    opened.push(server, hub, hostA, account);
    await Promise.all(
      [hub, hostA, account].map((c) => c.waitUntilSignedIn({ timeout: 5_000 })),
    );
    const calls: Array<[string, any]> = [];
    const impl: any = {};
    for (const [name] of METHODS) {
      impl[name] = jest.fn(async (opts) => {
        calls.push([name, opts]);
        return name === "syncComputerAccess"
          ? { enabled: true, revoked: [] }
          : name === "syncAccountRevocations"
            ? { rows: [] }
            : undefined;
      });
    }
    const service = createHostStatusService({ client: hub, impl });
    opened.push(service);
    await delay(50);
    return { server, hub, hostA, account, service, calls };
  }

  const CASES = MODES.flatMap((mode) =>
    METHODS.map(([name, opts]) => [mode, name, opts] as const),
  );

  it.each(CASES)(
    "%s: %s is bound to the calling host",
    async (mode, name, opts) => {
      const { hostA, account, hub, calls } = await setup(mode);
      const api = statusClient(hostA, mode);
      // another host's id, or none: acts as the caller
      await api[name]({ ...opts, host_id: HOST_B });
      await api[name]({ ...opts });
      for (const client of [account, hub]) {
        await expect(
          statusClient(client, mode)[name]({ ...opts, host_id: HOST_A }),
        ).rejects.toThrow(/requires an authenticated host/);
      }
      expect(calls).toEqual([
        [name, { ...opts, host_id: HOST_A }],
        [name, { ...opts, host_id: HOST_A }],
      ]);
    },
  );

  it("the server stamps a host's id into the caller ONLY on the host-status and registry subjects", async () => {
    const { hostA, hub } = await setup();
    for (const [subject, expected] of [
      ["project-hosts.status", { host_id: HOST_A }],
      ["project-hosts.api", { host_id: HOST_A }],
      ["project-hosts.other", undefined],
    ] as const) {
      const subscription = await hub.subscribe(subject);
      await hostA.conn.timeout(5_000).emitWithAck("publish", [
        subject,
        "binding-test",
        0,
        1,
        DataEncoding.JsonCodec,
        Buffer.from("null"),
        undefined,
        undefined,
        { host_id: HOST_B }, // a forged caller slot is replaced
      ]);
      expect((await subscription.next()).value?.caller ?? undefined).toEqual(
        expected,
      );
      subscription.close();
    }
  });

  it("a principal that is also an account or a project is never stamped as a host", async () => {
    const { server, hub } = await setup();
    for (const auth of [
      { host_id: HOST_A, account_id: "00000000-0000-4000-8000-0000000000cc" },
      { host_id: HOST_A, project_id: PROJECT },
    ]) {
      const mixed = connect({ address: server.address(), noCache: true, auth });
      opened.push(mixed);
      await mixed.waitUntilSignedIn({ timeout: 5_000 });
      for (const subject of ["project-hosts.status", "project-hosts.api"]) {
        const subscription = await hub.subscribe(subject);
        await mixed.publish(subject, null);
        const { value } = await subscription.next();
        expect(value?.caller?.host_id).toBeUndefined();
        subscription.close();
      }
    }
  });

  it("bindHostStatusArgs: no caller host is 403, the request's host_id is replaced, options are required", () => {
    expect(() =>
      bindHostStatusArgs("reportProjectState", [{ host_id: HOST_B }], {}),
    ).toThrow(/requires an authenticated host/);
    expect(
      bindHostStatusArgs("reportProjectState", [{ host_id: HOST_B, x: 1 }], {
        host_id: HOST_A,
      }),
    ).toEqual([{ host_id: HOST_A, x: 1 }]);
    expect(() =>
      bindHostStatusArgs("reportProjectState", [], { host_id: HOST_A }),
    ).toThrow(/requires its options/);
  });
});
