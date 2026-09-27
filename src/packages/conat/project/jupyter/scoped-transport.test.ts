/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

const mockSnapshots = new Map();
jest.mock("@cocalc/conat/project/jupyter/live-run", () => ({
  ...jest.requireActual("@cocalc/conat/project/jupyter/live-run"),
  openJupyterLiveRunStore: async () => ({
    set: (key, value) => mockSnapshots.set(key, value),
    delete: (key) => mockSnapshots.delete(key),
    close: () => {},
  }),
}));

import { randomUUID } from "node:crypto";
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

  it("delivers stdin, tagged output and completion without broad reply authority", async () => {
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
      getUser: async (socket) => socket.handshake.auth,
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
    const run = jest.fn(async ({ socket, cells }) =>
      (async function* () {
        const { data } = await socket.request(
          { type: "stdin", id: cells[0].id, prompt: "value?", password: false },
          { timeout: 2000 },
        );
        yield {
          id: cells[0].id,
          msg_type: "stream",
          content: { name: "stdout", text: data },
        };
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
      for await (const batch of await notebook.run(
        [{ id: "cell", input: "simulated input request" }],
        { run_id: "scoped-run", onAck },
      ))
        output.push(...batch);
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
      expect(output).toEqual([
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
      ]);
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
      notebook.close();
      server.close();
    }
  }, 10000);
});
