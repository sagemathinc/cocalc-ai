/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

jest.mock("@cocalc/conat/project/jupyter/live-run", () => ({
  ...jest.requireActual("@cocalc/conat/project/jupyter/live-run"),
  openJupyterLiveRunStore: async () => ({ set() {}, delete() {}, close() {} }),
}));

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kernel as createKernel } from "@cocalc/jupyter/kernel";
import { Client, connect } from "@cocalc/conat/core/client";
import { ConatServer, init } from "@cocalc/conat/core/server";
import {
  jupyterClient,
  jupyterServer,
  type OutputMessage,
} from "@cocalc/conat/project/jupyter/run-code";
import { isProjectHostApiKeySubjectAllowed } from "@cocalc/conat/auth/project-host-api-key-policy";
import type { ProjectHostApiKeyBinding } from "@cocalc/conat/auth/project-host-token";

const realKernelTest =
  process.env.COCALC_REAL_KERNEL_TEST === "1" ? it : it.skip;

realKernelTest(
  "runs Python and stdin through the scoped Jupyter transport",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scoped-jupyter-"));
    const kernel = createKernel({
      name: "python3",
      path: join(dir, "probe.ipynb"),
    });
    const project_id = randomUUID();
    const subject = `jupyter.project-${project_id}.0`;
    const prefix = `_INBOX.kernel-test-${randomUUID()}`;
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
    let server: ReturnType<typeof jupyterServer> | undefined;
    let notebook: ReturnType<typeof jupyterClient> | undefined;
    try {
      await kernel.ensureRunning();
      await service.waitUntilSignedIn({ timeout: 3000 });
      await client.waitUntilSignedIn({ timeout: 3000 });
      server = jupyterServer({
        client: service,
        project_id,
        getKernelStatus: async () => ({
          backend_state: "running",
          kernel_state: "idle",
          identity: kernel.identity,
        }),
        run: async ({ cells, socket }) =>
          (async function* () {
            for (const cell of cells) {
              const execution = kernel.execute_code({
                code: cell.input,
                stdin: async (prompt, password) =>
                  (
                    await socket.request(
                      { type: "stdin", id: cell.id, prompt, password },
                      { timeout: 3000 },
                    )
                  ).data,
              });
              for await (const message of execution.iter())
                yield { ...message, id: cell.id };
            }
          })(),
      });
      await server.waitUntilReady(3000);
      const stdin = jest.fn(async () => "17");
      notebook = jupyterClient({
        client,
        project_id,
        path: "probe.ipynb",
        stdin,
      });
      const output: OutputMessage[] = [];
      for await (const batch of await notebook.run(
        [
          {
            id: "input",
            input: "value = int(input('value?')); print(value * 3)",
          },
          { id: "reuse", input: "print(value + 1)" },
        ],
        { run_id: "real-python" },
      ))
        output.push(...batch);
      expect(stdin).toHaveBeenCalledTimes(1);
      expect(stdin).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "input",
          prompt: "value?",
          password: false,
        }),
      );
      const stdout = (id: string) =>
        output
          .filter(
            (m) =>
              m.id === id &&
              m.msg_type === "stream" &&
              m.content.name === "stdout",
          )
          .map((m) => m.content.text)
          .join("");
      expect(stdout("input")).toBe("51\n");
      expect(stdout("reuse")).toBe("18\n");
      expect(output.some((m) => m.msg_type === "error")).toBe(false);
      expect(output.every((m) => m.run_id === "real-python")).toBe(true);
      const errors: OutputMessage[] = [];
      for await (const batch of await notebook.run(
        [{ id: "error", input: "raise RuntimeError('scoped-probe')" }],
        { run_id: "real-error" },
      ))
        errors.push(...batch);
      expect(errors).toContainEqual(
        expect.objectContaining({
          id: "error",
          run_id: "real-error",
          msg_type: "error",
          content: expect.objectContaining({
            ename: "RuntimeError",
            evalue: "scoped-probe",
          }),
        }),
      );
      const recovered: OutputMessage[] = [];
      for await (const batch of await notebook.run(
        [{ id: "after-error", input: "print(value)" }],
        { run_id: "real-recovery" },
      ))
        recovered.push(...batch);
      expect(
        recovered
          .filter((m) => m.msg_type === "stream")
          .map((m) => m.content.text)
          .join(""),
      ).toBe("17\n");
      await expect(
        client.subscribe(subject + ".client.other"),
      ).rejects.toMatchObject({ code: 403 });
    } finally {
      notebook?.close();
      server?.close();
      kernel.close();
      await kernel.waitUntilClosed();
      Client.closeAllForTests();
      await ConatServer.closeAllForTests();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);
