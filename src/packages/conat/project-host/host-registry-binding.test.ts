/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Finding 068-2: every host-registry request acts for the host that sent it.
// register and heartbeat may report only the calling host (a mismatched id is
// refused, never rewritten), every other method gets the caller's host_id,
// and only the public key is unbound.

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
import { createServiceClient } from "../service/typed";
import {
  bindHostRegistryArgs,
  createHostRegistryClient,
  createHostRegistryService,
  HOST_REGISTRY_BINDING,
} from "./api";

const HOST_A = "00000000-0000-4000-8000-00000000000a";
const HOST_B = "00000000-0000-4000-8000-00000000000b";

// Every HostRegistryApi method, written out so the binding table is checked
// against an independent list (the table itself is typed over the interface).
const REGISTRY_METHODS = [
  "register",
  "heartbeat",
  "shutdownNotice",
  "getProjectHostAuthPublicKey",
  "listProjectUserDeltas",
  "listProjectUserReconcile",
  "listProjectStopPolicyDeltas",
  "listProjectStopPolicyReconcile",
  "reportProjectPressureAction",
  "getMasterConatTokenStatus",
  "rotateMasterConatToken",
] as const;
const REPORTS = ["register", "heartbeat"];
const UNBOUND = ["getProjectHostAuthPublicKey"];
const BOUND = REGISTRY_METHODS.filter(
  (name) => !REPORTS.includes(name) && !UNBOUND.includes(name),
);

const MODES = ["fast-rpc", "legacy", "request"] as const;
type Mode = (typeof MODES)[number];

function registryClient(client, mode: Mode): any {
  return mode === "fast-rpc"
    ? createHostRegistryClient({ client })
    : createServiceClient({
        service: "project-host",
        subject: "project-hosts.api",
        client,
        transport: "request",
      });
}

describe("host-registry requests are bound to the calling host (068-2)", () => {
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
    const calls: Array<[string, any[]]> = [];
    const impl: any = {};
    for (const name of REGISTRY_METHODS) {
      impl[name] = jest.fn(async (...args) => {
        calls.push([name, args]);
        return null;
      });
    }
    const service = createHostRegistryService({ client: hub, impl });
    opened.push(service);
    await delay(50);
    return { hub, hostA, account, calls };
  }

  const CASES = MODES.flatMap((mode) =>
    REGISTRY_METHODS.map((name) => [mode, name] as const),
  );

  it.each(CASES)("%s: %s is bound to the calling host", async (mode, name) => {
    const { hostA, account, hub, calls } = await setup(mode);
    const api = registryClient(hostA, mode);
    const others = [account, hub].map((c) => registryClient(c, mode));
    if (REPORTS.includes(name)) {
      // another host's id, or none: refused, never rewritten
      for (const info of [
        { id: HOST_B, status: "running" },
        { status: "running" },
      ]) {
        await expect(api[name](info)).rejects.toThrow(
          /may only report the calling host/,
        );
      }
      await api[name]({ id: HOST_A, status: "running" });
      for (const other of others) {
        await expect(other[name]({ id: HOST_A })).rejects.toThrow(
          /requires an authenticated host/,
        );
      }
      expect(calls).toEqual([[name, [{ id: HOST_A, status: "running" }]]]);
    } else if (UNBOUND.includes(name)) {
      await api[name]();
      for (const other of others) {
        await other[name]();
      }
      expect(calls).toEqual([
        [name, []],
        [name, []],
        [name, []],
      ]);
    } else {
      // another host's id, or none: acts as the caller
      await api[name]({ host_id: HOST_B, x: 1 });
      await api[name]({ x: 1 });
      for (const other of others) {
        await expect(other[name]({ host_id: HOST_A })).rejects.toThrow(
          /requires an authenticated host/,
        );
      }
      expect(calls).toEqual([
        [name, [{ host_id: HOST_A, x: 1 }]],
        [name, [{ host_id: HOST_A, x: 1 }]],
      ]);
    }
  });

  it("the binding table covers exactly the registry methods, and only the public key is unbound", () => {
    expect(Object.keys(HOST_REGISTRY_BINDING).sort()).toEqual(
      [...REGISTRY_METHODS].sort(),
    );
    expect(
      Object.entries(HOST_REGISTRY_BINDING)
        .filter(([, b]) => b !== "bound")
        .sort(),
    ).toEqual([
      ["getProjectHostAuthPublicKey", "public"],
      ["heartbeat", "report"],
      ["register", "report"],
    ]);
    // an unknown name fails closed, also for a host
    expect(() =>
      bindHostRegistryArgs("toString", [{}], { host_id: HOST_A }),
    ).toThrow(/unknown host registry method/);
  });

  it("bindHostRegistryArgs: no caller host is 403, ids are checked or replaced, options are required", () => {
    for (const name of [...REPORTS, ...BOUND]) {
      expect(() => bindHostRegistryArgs(name, [{ id: HOST_A }], {})).toThrow(
        /requires an authenticated host/,
      );
      expect(() => bindHostRegistryArgs(name, [], { host_id: HOST_A })).toThrow(
        /requires its options/,
      );
    }
    expect(
      bindHostRegistryArgs("heartbeat", [{ id: HOST_A }], { host_id: HOST_A }),
    ).toEqual([{ id: HOST_A }]);
    expect(() =>
      bindHostRegistryArgs("heartbeat", [{ id: HOST_B }], { host_id: HOST_A }),
    ).toThrow(/may only report the calling host/);
    expect(
      bindHostRegistryArgs("shutdownNotice", [{ host_id: HOST_B }], {
        host_id: HOST_A,
      }),
    ).toEqual([{ host_id: HOST_A }]);
    expect(bindHostRegistryArgs("getProjectHostAuthPublicKey", [], {})).toEqual(
      [],
    );
  });
});
