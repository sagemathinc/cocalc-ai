/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

const mockSnapshots = new Map();
jest.mock("@cocalc/conat/project/jupyter/live-run", () => ({
  ...jest.requireActual("@cocalc/conat/project/jupyter/live-run"),
  openJupyterLiveRunStore: async () => ({
    set: (key, value) => mockSnapshots.set(key, value),
    get: (key) => mockSnapshots.get(key),
    delete: (key) => mockSnapshots.delete(key),
    close: () => {},
  }),
}));

import { randomUUID } from "node:crypto";
import { delay } from "awaiting";
import { Client, connect } from "../../core/client";
import { ConatServer, init } from "../../core/server";
import { isProjectHostApiKeySubjectAllowed } from "../../auth/project-host-api-key-policy";
import type { ProjectHostApiKeyBinding } from "../../auth/project-host-token";
import { jupyterClient, jupyterServer, type OutputMessage } from "./run-code";

describe("Jupyter application over scoped transport", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
    mockSnapshots.clear();
  });

  it.each([false, "close", "disconnect", "lease"] as const)(
    "delivers output or explicit transport loss without replay (interrupt=%s)",
    async (interrupt) => {
      const project_id = randomUUID();
      const subject = `jupyter.project-${project_id}.0`;
      const prefix = `_INBOX.jupyter-test-${randomUUID()}`;
      const binding = {
        reply_prefix: prefix,
        subjects: [subject + "."],
      } as ProjectHostApiKeyBinding;
      const broker = init({
        port: 0,
        autoscanInterval: 0,
        getUser: async (socket) => ({
          ...socket.handshake.auth,
          ...(interrupt === "lease" && !socket.handshake.auth.hub_id
            ? { auth_lease_exp_s: Math.ceil(Date.now() / 1000) + 2 }
            : {}),
        }),
        isAllowed: async ({ user, subject, type }) =>
          user?.hub_id === "service" ||
          isProjectHostApiKeySubjectAllowed({ binding, subject, type }),
      });
      const service = connect({
        address: broker.address(),
        noCache: true,
        auth: { hub_id: "service" },
      });
      const client = connect({
        address: broker.address(),
        noCache: true,
        reconnection: false,
        auth: { account_id: "test" },
        inboxPrefix: prefix,
      });
      await service.waitUntilSignedIn({ timeout: 3000 });
      await client.waitUntilSignedIn({ timeout: 3000 });
      let releaseRun = () => {};
      const runGate = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      const run = jest.fn(async ({ socket, cells }) =>
        (async function* () {
          const { data } = await socket.request(
            {
              type: "stdin",
              id: cells[0].id,
              prompt: "value?",
              password: false,
            },
            { timeout: 2000 },
          );
          yield {
            id: cells[0].id,
            msg_type: "stream",
            content: { name: "stdout", text: data },
          };
          if (interrupt) await runGate;
          yield { id: cells[0].id, lifecycle: "cell_done" as const };
        })(),
      );
      const status = {
        backend_state: "running" as const,
        kernel_state: "idle" as const,
        identity: "simulated-kernel",
      };
      const server = jupyterServer({
        client: service,
        project_id,
        run,
        outputHandler: () => ({ process: () => {}, done: () => {} }),
        getKernelStatus: async () => status,
      });
      await server.waitUntilReady(3000);
      const stdin = jest.fn(async () => "answer-from-scoped-client");
      const notebook = jupyterClient({
        client,
        project_id,
        path: "transport.ipynb",
        stdin,
      });
      try {
        expect(await notebook.getKernelStatus()).toEqual(status);
        const output: OutputMessage[] = [];
        const onAck = jest.fn();
        const iterator = await notebook.run(
          [{ id: "cell", input: "simulated input request" }],
          { run_id: "scoped-run", onAck },
        );
        if (interrupt) {
          const first = await iterator.next();
          output.push(...first.value);
          if (interrupt === "disconnect") client.conn.disconnect();
          else if (interrupt !== "lease") notebook.socket.close();
          await expect(iterator.next()).rejects.toMatchObject({
            code: "JUPYTER_RUN_TRANSPORT_LOST",
            run_id: "scoped-run",
          });
          if (interrupt === "disconnect" || interrupt === "lease") {
            client.conn.connect();
            await client.waitUntilSignedIn({ timeout: 3000 });
          }
          releaseRun();
          const fresh = jupyterClient({
            client,
            project_id,
            path: "transport.ipynb",
            stdin,
          });
          try {
            expect(await fresh.getKernelStatus()).toEqual(status);
            expect(
              await fresh.getRun("scoped-run", { limit: 1 }),
            ).toMatchObject({ run_id: "scoped-run", next_seq: 1 });
            expect(await fresh.getRun("absent-run")).toBeNull();
          } finally {
            fresh.close();
          }
        } else {
          for await (const batch of iterator) output.push(...batch);
        }
        expect(onAck).toHaveBeenCalledWith(
          expect.objectContaining({ run_id: "scoped-run" }),
        );
        expect(run).toHaveBeenCalledTimes(1);
        expect(stdin).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "cell",
            prompt: "value?",
            password: false,
          }),
        );
        const expected = [
          {
            id: "cell",
            run_id: "scoped-run",
            msg_type: "stream",
            content: { name: "stdout", text: "answer-from-scoped-client" },
          },
          {
            id: "cell",
            run_id: "scoped-run",
            msg_type: "cell_done",
            lifecycle: "cell_done",
          },
        ];
        expect(output).toEqual(interrupt ? expected.slice(0, 1) : expected);
        for (
          let n = 0;
          n < 100 && ![...mockSnapshots.values()].some((x) => x.done);
          n++
        )
          await delay(10);
        expect([...mockSnapshots.values()]).toEqual([
          expect.objectContaining({ done: true, run_id: "scoped-run" }),
        ]);
        await expect(
          client.subscribe(subject + ".client.other"),
        ).rejects.toMatchObject({ code: 403 });
        await expect(
          client.publish(prefix + ".other", null, { waitForInterest: false }),
        ).rejects.toMatchObject({ code: 403 });
      } finally {
        releaseRun();
        notebook.close();
        server.close();
      }
    },
    10000,
  );
});
