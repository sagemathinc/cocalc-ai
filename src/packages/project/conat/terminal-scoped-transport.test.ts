/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { spawn } from "node-pty";
import { randomUUID } from "node:crypto";
import { delay } from "awaiting";
import { Client, connect } from "@cocalc/conat/core/client";
import { ConatServer, init } from "@cocalc/conat/core/server";
import { terminalClient, terminalServer } from "@cocalc/conat/project/terminal";
import { isProjectHostApiKeySubjectAllowed } from "@cocalc/conat/auth/project-host-api-key-policy";
import type { ProjectHostApiKeyBinding } from "@cocalc/conat/auth/project-host-token";

describe("terminal over scoped project-host transport", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  it.each([false, true])(
    "runs a real PTY with confined replies and session reattachment (rotate=%s)",
    async (rotate) => {
      const project_id = randomUUID();
      const prefix = `_INBOX.terminal-test-${randomUUID()}`;
      const subject = `terminal.project-${project_id}.0`;
      const binding = {
        reply_prefix: prefix,
        subjects: [subject + "."],
      } as ProjectHostApiKeyBinding;
      const broker = init({
        port: 0,
        autoscanInterval: 0,
        getUser: async (socket) => ({
          ...socket.handshake.auth,
          reply_prefix: rotate
            ? `_INBOX.terminal-test-${randomUUID()}`
            : prefix,
        }),
        isAllowed: async ({ user, subject, type }) =>
          user?.hub_id === "service" ||
          isProjectHostApiKeySubjectAllowed({
            binding: { ...binding, reply_prefix: user.reply_prefix },
            subject,
            type,
          }),
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
      client.inboxPrefixHook = (info) => info?.user?.reply_prefix;
      await service.waitUntilSignedIn({ timeout: 5000 });
      await client.waitUntilSignedIn({ timeout: 5000 });
      let pty: ReturnType<typeof spawn> | undefined;
      let spawnCount = 0;
      const listener = terminalServer({
        client: service,
        project_id,
        // The service uses the synchronous provider used by the project runtime.
        spawn: ((command, args, options) => {
          spawnCount++;
          pty = spawn(command, args, options);
          return pty;
        }) as unknown as Parameters<typeof terminalServer>[0]["spawn"],
      });
      await listener.waitUntilReady(5000);
      let terminal = terminalClient({
        client,
        project_id,
        reconnection: true,
        getSize: () => ({ rows: 31, cols: 97 }),
      });
      const id = randomUUID();
      let output = "";
      terminal.socket.on("data", (data) => (output += String(data)));
      try {
        await expect(terminal.attach(id, { timeout: 5000 })).rejects.toThrow(
          "terminal session is not running",
        );
        expect(spawnCount).toBe(0);
        await terminal.spawn("/bin/bash", ["--noprofile", "--norc"], {
          id,
          env: { PATH: "/usr/bin:/bin", TERM: "xterm", PS1: "" },
          timeout: 5000,
        });
        const pid = terminal.pid;
        expect(pid).toBeGreaterThan(0);
        expect(await terminal.state(id)).toBe("running");
        const marker = `shell-result-${randomUUID()}`;
        expect(
          await terminal.write({
            id,
            input: `printf '%s%s\\n' 'shell-result-' '${marker.slice(13)}'\n`,
            kind: "user",
          }),
        ).toMatchObject({ written: true });
        for (let n = 0; n < 100 && !output.includes(marker); n++)
          await delay(20);
        expect(output).toContain(marker);
        expect(await terminal.history(id)).toContain(marker);
        expect(await terminal.sizes(200)).toContainEqual({
          rows: 31,
          cols: 97,
        });
        const writer = terminalClient({
          client,
          project_id,
          reconnection: false,
        });
        try {
          expect(await writer.write({ id, input: "ignored\n" })).toMatchObject({
            written: false,
            reason: "terminal has an active browser leader",
          });
          await terminal.closeAndWait();
          expect(await writer.state(id)).toBe("running");
          const detachedMarker = `detached-${randomUUID()}`;
          expect(
            await writer.write({
              id,
              input: `printf '%s%s\\n' 'detached-' '${detachedMarker.slice(9)}'\n`,
            }),
          ).toMatchObject({ written: true });
          for (let n = 0; n < 100; n++) {
            if ((await writer.history(id))?.includes(detachedMarker)) break;
            await delay(20);
          }
          expect(await writer.history(id)).toContain(detachedMarker);
        } finally {
          writer.close();
        }
        terminal = terminalClient({ client, project_id, reconnection: true });
        await terminal.attach(id, { timeout: 5000 });
        expect(terminal.pid).toBe(pid);
        await expect(
          client.subscribe(subject + ".client.foreign"),
        ).rejects.toMatchObject({ code: 403 });
        await expect(
          client.publish(prefix + ".foreign", null, { waitForInterest: false }),
        ).rejects.toMatchObject({ code: 403 });

        if (rotate) {
          const closed = new Promise<void>((resolve) =>
            terminal.socket.once("closed", resolve),
          );
          const previousPrefix = client.info!.user.reply_prefix;
          client.conn.disconnect();
          const signedIn = new Promise<void>((resolve) =>
            client.once("info", () => resolve()),
          );
          client.conn.connect();
          await signedIn;
          await closed;
          expect(terminal.socket.closeReason).toBe("reply-namespace-changed");
          expect(terminal.socket.state).toBe("closed");
          await expect(terminal.history(id)).rejects.toThrow("closed");
          expect(() => terminal.socket.write("discarded input")).toThrow(
            "closed",
          );
          expect(client.info!.user.reply_prefix).not.toBe(previousPrefix);
          await expect(
            client.subscribe(previousPrefix + ".probe"),
          ).rejects.toMatchObject({ code: 403 });
        }
        terminal.close();
        terminal = terminalClient({ client, project_id, reconnection: false });
        output = "";
        terminal.socket.on("data", (data) => (output += String(data)));
        expect(await terminal.attach(id, { timeout: 5000 })).toContain(marker);
        expect(terminal.pid).toBe(pid);
        expect(spawnCount).toBe(1);
        await expect(
          terminal.attach(randomUUID(), { timeout: 5000 }),
        ).rejects.toThrow("terminal session is not running");
        const resumedMarker = `resumed-${randomUUID()}`;
        expect(
          await terminal.write({
            id,
            input: `printf '%s%s\\n' 'resumed-' '${resumedMarker.slice(8)}'\n`,
            kind: "user",
          }),
        ).toMatchObject({ written: true });
        for (let n = 0; n < 100 && !output.includes(resumedMarker); n++)
          await delay(20);
        expect(output).toContain(resumedMarker);
        const exited = new Promise<void>((resolve) =>
          pty!.onExit(() => resolve()),
        );
        await terminal.destroy();
        await Promise.race([
          exited,
          delay(3000).then(() => {
            throw Error("PTY did not exit after destroy");
          }),
        ]);
        expect(await terminal.state(id)).toBe("off");
        await expect(terminal.attach(id, { timeout: 5000 })).rejects.toThrow(
          "terminal session is not running",
        );
        expect(spawnCount).toBe(1);
      } finally {
        pty?.kill();
        terminal.close();
        listener.close();
      }
    },
    20000,
  );
});
