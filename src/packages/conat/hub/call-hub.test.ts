/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/conat/core/client";
import { withTimeout } from "@cocalc/util/async-utils";
import callHub, { annotateCallHubError, requestHub } from "./call-hub";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("host resolver single-flight at the outbound RPC boundary", () => {
  const subject = "hub.account.account-1.api";
  const data = {
    name: "hosts.resolveHostConnection",
    args: [{ host_id: "host-1" }],
  };

  function setup() {
    const requests: ReturnType<typeof deferred<{ data: unknown }>>[] = [];
    const request = jest.fn(() => {
      const pending = deferred<{ data: unknown }>();
      requests.push(pending);
      return pending.promise;
    });
    const client = {
      request,
      info: {
        user: { account_id: "account-1", auth_session_hash: "session-1" },
      },
    } as unknown as Client;
    const resolve = (
      args: Record<string, string>[] = data.args,
      overrides = {},
    ) =>
      callHub({
        client,
        account_id: "account-1",
        ...data,
        args,
        ...overrides,
      });
    return { client, request, requests, resolve };
  }

  it("converges SDK and direct calls for 300 same-host lookups without caching results", async () => {
    const { client, request, requests, resolve } = setup();
    const sdk = Array.from({ length: 300 }, () => resolve());
    const direct = requestHub(
      client,
      subject,
      { ...data, auth_session_hash: "session-1" },
      { timeout: 5_000 },
    );
    expect(request).toHaveBeenCalledTimes(1);
    requests[0].resolve({ data: { host_id: "host-1" } });
    expect(await Promise.all(sdk)).toHaveLength(300);
    await expect(direct).resolves.toEqual({ data: { host_id: "host-1" } });
    const next = resolve();
    expect(request).toHaveBeenCalledTimes(2);
    requests[1].resolve({ data: { host_id: "host-1", changed: true } });
    await expect(next).resolves.toMatchObject({ changed: true });
  });

  it("keeps the underlying flight after repeated outer five-second timeouts", async () => {
    jest.useFakeTimers();
    try {
      const { request, requests, resolve } = setup();
      for (let i = 0; i < 300; i++) {
        const timed = withTimeout(resolve(), 5_000).catch(() => "timed out");
        await jest.advanceTimersByTimeAsync(5_001);
        expect(await timed).toBe("timed out");
      }
      expect(request).toHaveBeenCalledTimes(1);
      const joined = resolve();
      requests[0].resolve({ data: "reconnected" });
      await expect(joined).resolves.toBe("reconnected");
      const next = resolve();
      expect(request).toHaveBeenCalledTimes(2);
      requests[1].resolve({ data: "fresh" });
      await next;
    } finally {
      jest.useRealTimers();
    }
  });

  it("a five-second waiter cannot shorten the underlying fifteen-second request lifetime", async () => {
    jest.useFakeTimers();
    try {
      const request = jest.fn(
        (_subject, _data, { timeout }) =>
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("transport deadline")), timeout);
          }),
      );
      const client = { request } as unknown as Client;
      const resolve = (timeout = 15_000) =>
        callHub({
          client,
          account_id: "account-1",
          ...data,
          timeout,
        });
      const underlying = resolve().catch((err) => err.message);
      for (let i = 0; i < 2; i++) {
        const outer = withTimeout(resolve(5_000), 5_000).catch(
          () => "outer timeout",
        );
        await jest.advanceTimersByTimeAsync(5_000);
        expect(await outer).toBe("outer timeout");
        expect(request).toHaveBeenCalledTimes(1);
      }
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await underlying).toContain("transport deadline");
      const retry = resolve().catch((err) => err.message);
      expect(request).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(15_000);
      await retry;
    } finally {
      jest.useRealTimers();
    }
  });

  it("separates Client identity, subjects, auth sessions and all resolver arguments", async () => {
    const { client, request, requests, resolve } = setup();
    const scopes = [
      { host_id: "host-1" },
      { host_id: "host-2" },
      { host_id: "host-1", project_id: "project-1" },
      { host_id: "host-1", project_id: "project-2" },
      { host_id: "host-1", public_directory_share_id: "share-1" },
      { host_id: "host-1", public_directory_share_id: "share-2" },
      { host_id: "host-1", account_id: "account-2" },
    ];
    const pending = scopes.map((scope) => resolve([scope]));
    // Object property order is not a different scope.
    pending.push(resolve([{ project_id: "project-1", host_id: "host-1" }]));
    expect(request).toHaveBeenCalledTimes(scopes.length);
    pending.push(resolve(undefined, { account_id: "account-2" }));
    pending.push(resolve(undefined, { auth_session_hash: "explicit-session" }));
    pending.push(resolve(undefined, { client: { ...client } }));
    client.info!.user!.auth_session_hash = "session-2";
    pending.push(resolve());
    client.info!.user!.account_id = "account-2";
    pending.push(resolve());
    expect(request).toHaveBeenCalledTimes(scopes.length + 5);
    requests.forEach((p, i) => p.resolve({ data: i }));
    const results = await Promise.all(pending);
    expect(results.slice(0, scopes.length)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(results[scopes.length]).toBe(2);
  });

  it("old-account completion does not clear a newer pending flight", async () => {
    const { client, request, requests, resolve } = setup();
    const old = resolve();
    client.info!.user!.account_id = "account-2";
    const current = resolve(undefined, { account_id: "account-2" });
    requests[0].resolve({ data: "old" });
    await old;
    const joined = resolve(undefined, { account_id: "account-2" });
    expect(request).toHaveBeenCalledTimes(2);
    requests[1].resolve({ data: "current" });
    await expect(current).resolves.toBe("current");
    await expect(joined).resolves.toBe("current");
    const next = resolve(undefined, { account_id: "account-2" });
    expect(request).toHaveBeenCalledTimes(3);
    requests[2].resolve({ data: "next" });
    await next;
  });

  it("evicts errors for retry without multiplying shared error annotations", async () => {
    const { request, requests, resolve } = setup();
    const pending = Promise.allSettled(
      Array.from({ length: 300 }, () => resolve()),
    );
    requests[0].reject(new Error("offline"));
    const results = await pending;
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason.message.match(/callHub:/g)).toHaveLength(1);
      }
    }
    const retry = resolve();
    expect(request).toHaveBeenCalledTimes(2);
    requests[1].resolve({ data: "retried" });
    await expect(retry).resolves.toBe("retried");
  });

  it.each(["hosts.issueProjectHostAuthToken", "projects.startProject"])(
    "does not coalesce %s",
    async (name) => {
      const { request, requests, resolve } = setup();
      const pending = Array.from({ length: 3 }, () =>
        resolve(undefined, { name }),
      );
      expect(request).toHaveBeenCalledTimes(3);
      requests.forEach((p) => p.resolve({ data: "ok" }));
      await Promise.all(pending);
    },
  );
});

describe("annotateCallHubError", () => {
  const context = {
    subject: "hub.account.account-1.api",
    name: "projects.getProjectRootfs",
  };

  it("preserves an Error while replacing a missing message", () => {
    const err = Object.assign(new Error("temporary"), { code: 503 });
    err.message = undefined as any;

    const annotated = annotateCallHubError({ err, ...context });

    expect(annotated).toBe(err);
    expect(annotated.message).toBe(
      "hub request failed - callHub: subject='hub.account.account-1.api', name='projects.getProjectRootfs', code='503'",
    );
    expect((annotated as any).code).toBe(503);
  });

  it("uses an error field from a non-Error rejection", () => {
    const annotated = annotateCallHubError({
      err: { error: "project is unavailable", code: "PROJECT_UNAVAILABLE" },
      ...context,
    });

    expect(annotated).toBeInstanceOf(Error);
    expect(annotated.message).toBe(
      "project is unavailable - callHub: subject='hub.account.account-1.api', name='projects.getProjectRootfs', code='PROJECT_UNAVAILABLE'",
    );
    expect((annotated as any).code).toBe("PROJECT_UNAVAILABLE");
  });

  it("gives an undefined rejection a useful fallback", () => {
    expect(annotateCallHubError({ err: undefined, ...context }).message).toBe(
      "hub request failed - callHub: subject='hub.account.account-1.api', name='projects.getProjectRootfs', code='unknown'",
    );
  });
});
