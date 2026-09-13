/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

jest.mock("@cocalc/backend/conat", () => ({ conat: jest.fn() }));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: jest.fn(() => false),
}));
jest.mock("./dispatch", () => ({
  dispatchBillingAuthorityCommand: jest.fn(),
}));

import { __test__, createBillingAuthorityApi } from "./service";
import {
  getBillingAuthorityContext,
  resetBillingAuthorityContextForTests,
} from "./context";
import type { BillingAuthorityRequest } from "./protocol";

function command(request_id: string): BillingAuthorityRequest {
  return {
    request_id,
    command: { kind: "maintenance", task: "statements" },
  };
}

function read(request_id: string): BillingAuthorityRequest {
  return {
    request_id,
    command: {
      kind: "hub-api",
      call: { name: "purchases.getBalance", args: [] },
    },
  };
}

describe("billing authority service API", () => {
  afterEach(resetBillingAuthorityContextForTests);

  it("serializes commands and installs command-local authority context", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const contexts: Array<ReturnType<typeof getBillingAuthorityContext>> = [];
    const dispatch = jest.fn(async () => {
      contexts.push(getBillingAuthorityContext());
      if (contexts.length === 1) await gate;
      return contexts.length;
    });
    const api = createBillingAuthorityApi({ dispatch });

    const first = api.executeCommand(command("one"));
    const second = api.executeCommand(command("two"));
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, value: 1 },
      { ok: true, value: 2 },
    ]);
    expect(contexts).toEqual([
      { operation: "maintenance:statements", request_id: "one" },
      { operation: "maintenance:statements", request_id: "two" },
    ]);
  });

  it("allows an approved read to run while a command is waiting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const dispatch = jest.fn(async (value) => {
      if (value.kind === "maintenance") await gate;
      return value.kind;
    });
    const api = createBillingAuthorityApi({ dispatch });

    const pendingCommand = api.executeCommand(command("command"));
    await Promise.resolve();
    await expect(api.executeRead(read("read"))).resolves.toEqual({
      ok: true,
      value: "hub-api",
    });
    release();
    await expect(pendingCommand).resolves.toEqual({
      ok: true,
      value: "maintenance",
    });
  });

  it("rejects a command presented through the concurrent read endpoint", async () => {
    const dispatch = jest.fn();
    const api = createBillingAuthorityApi({ dispatch });
    await expect(api.executeRead(command("bad-read"))).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: 400, status: 400 }),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects non-billing Hub API calls at the authority boundary", async () => {
    const dispatch = jest.fn();
    const api = createBillingAuthorityApi({ dispatch });
    await expect(
      api.executeCommand({
        request_id: "not-billing",
        command: {
          kind: "hub-api",
          call: { name: "system.setSiteSettings", args: [] },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: 400, status: 400 }),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns a structured error for malformed requests", async () => {
    const dispatch = jest.fn();
    const api = createBillingAuthorityApi({ dispatch });
    for (const request of [
      null,
      {},
      { request_id: "read" },
      { request_id: "read", command: { kind: "hub-api" } },
    ]) {
      await expect(api.executeCommand(request as any)).resolves.toEqual({
        ok: false,
        error: expect.objectContaining({ code: 400, status: 400 }),
      });
      await expect(api.executeRead(request as any)).resolves.toEqual({
        ok: false,
        error: expect.objectContaining({ code: 400, status: 400 }),
      });
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not start queued work after the election lease is lost", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let authorityActive = true;
    const dispatch = jest.fn(async () => await gate);
    const api = createBillingAuthorityApi({
      dispatch,
      authorityActive: () => authorityActive,
    });

    const first = api.executeCommand(command("first"));
    const second = api.executeCommand(command("second"));
    await Promise.resolve();
    authorityActive = false;
    release();

    await expect(first).resolves.toEqual({ ok: true, value: null });
    await expect(second).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: 503, status: 503 }),
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects a responder that is not the elected process", async () => {
    const health = {
      active: false,
      queue_depth: 0,
      completed: 0,
      failed: 0,
      started_at: new Date().toISOString(),
    };
    await expect(
      __test__.assertElectedServiceHealthy({
        health: async () => ({ ...health, pid: process.pid }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      __test__.assertElectedServiceHealthy({
        health: async () => ({ ...health, pid: process.pid + 1 }),
      }),
    ).rejects.toThrow("split-brain detected");
  });

  it("fail-stops an elected worker before another authority can take over", () => {
    const calls: string[] = [];
    expect(() =>
      __test__.failStopBillingAuthorityWorker({
        err: new Error("lease lost"),
        deactivate: () => calls.push("deactivate"),
        closeService: () => calls.push("close"),
        exit: (code) => {
          calls.push(`exit:${code}`);
          throw new Error("worker exited");
        },
      }),
    ).toThrow("worker exited");
    expect(calls).toEqual(["deactivate", "close", "exit:1"]);
  });
});
