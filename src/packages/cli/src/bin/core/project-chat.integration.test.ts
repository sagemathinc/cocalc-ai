import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import getPort from "@cocalc/backend/get-port";
import { init as createConatServer } from "@cocalc/conat/core/server";
import { server as createPersistServer } from "@cocalc/backend/conat/persist";
import { syncFiles } from "@cocalc/conat/persist/context";
import type { Client } from "@cocalc/conat/core/client";
import { localPathFileserver } from "@cocalc/backend/conat/files/local-path";
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import { initializeHumanRoom } from "@cocalc/chat";
import { createProjectChatOps } from "./project-chat";

test(
  "CLI create loads missing nested chat paths before mkdir and never writes agent config in a canonical room",
  { timeout: 30_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "cli-project-chat-"));
    const projectId = randomUUID();
    const accountId = randomUUID();
    const mutations: { op: string; path?: string }[] = [];
    const diskReads: { path: string; parentExists: boolean }[] = [];
    const priorLocal = syncFiles.local;
    let server: ReturnType<typeof createConatServer> | undefined;
    let persist: ReturnType<typeof createPersistServer> | undefined;
    let client: Client | undefined;
    const documents: Awaited<ReturnType<typeof acquireChatSyncDB>>[] = [];
    let files: Awaited<ReturnType<typeof localPathFileserver>> | undefined;
    try {
      server = createConatServer({ port: await getPort() });
      if (server.state !== "ready") await once(server, "ready");
      client = server.client({ noCache: true });
      syncFiles.local = join(home, ".persist");
      persist = createPersistServer({ client });
      files = await localPathFileserver({
        client,
        path: home,
        project_id: projectId,
        homeAliases: ["/home/user"],
        disableOpenAt2: true,
        onMutation: ({ op, path }) => {
          mutations.push({ op, path });
        },
        wrapFilesystem: (fs) => {
          const read = fs.readFile.bind(fs);
          fs.readFile = async (...args: Parameters<typeof fs.readFile>) => {
            diskReads.push({
              path: args[0],
              parentExists: await fs.exists(dirname(args[0])),
            });
            return await read(...args);
          };
          return fs;
        },
        jupyter: {
          importIpynb: async () => {
            throw Error("not used by chat");
          },
          saveIpynb: async () => {
            throw Error("not used by chat");
          },
        },
      });
      const ops = createProjectChatOps({
        readAccountSettings: async () => ({}),
        resolveProjectConatClient: async () => ({
          project: {
            project_id: projectId,
            title: "Test project",
            host_id: "test-host",
          },
          client,
        }),
      });
      const ctx = { accountId };
      for (const path of [
        "new/nonexistent/directory/chat.chat",
        "/home/user/another/nested/agent.chat",
      ]) {
        const relative = path.replace(/^\/home\/user\//, "");
        await assert.rejects(stat(join(home, dirname(relative))), {
          code: "ENOENT",
        });
        const threadId = randomUUID();
        const result = await ops.projectChatThreadCreateData({
          ctx,
          path,
          threadId,
          agentKind: "acp",
          acpConfig: { model: "gpt-5" },
        });
        assert.equal(result.created, true);
        assert.ok(
          diskReads.some(
            (read) => read.path.endsWith(relative) && !read.parentExists,
          ),
        );
        const rows = (await readFile(join(home, relative), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].thread_id, threadId);
        assert.equal(rows[0].agent_kind, "acp");
        assert.equal(rows[0].acp_config.model, "gpt-5");
        documents.push(
          await acquireChatSyncDB({
            client,
            project_id: projectId,
            path,
            readyTimeoutMs: 10_000,
          }),
        );
        await releaseChatSyncDB(projectId, path);
      }

      // Existing room content must be read before deciding whether mkdir or an
      // agent config write is allowed, including the normal relative path form.
      const room = {
        project_id: projectId,
        room_id: randomUUID(),
        chat_path: "/home/user/human.chat",
      };
      const db = await acquireChatSyncDB({
        client,
        project_id: projectId,
        path: room.chat_path,
        readyTimeoutMs: 10_000,
      });
      documents.push(db);
      try {
        await initializeHumanRoom(db, room);
        const original = await readFile(join(home, "human.chat"), "utf8");
        mutations.length = 0;
        await assert.rejects(
          ops.projectChatThreadCreateData({
            ctx,
            path: "human.chat",
            threadId: randomUUID(),
            agentKind: "acp",
            acpConfig: {},
          }),
          /human-only/,
        );
        assert.deepEqual(mutations, []);
        assert.equal(
          await readFile(join(home, "human.chat"), "utf8"),
          original,
        );
        assert.equal(
          db.get().some((row) => row.event === "chat-thread-config"),
          false,
        );
      } finally {
        await releaseChatSyncDB(projectId, room.chat_path);
      }
    } finally {
      for (const db of documents) await db.close();
      await files?.close();
      await persist?.close();
      client?.close();
      await server?.close();
      syncFiles.local = priorLocal;
      await rm(home, { recursive: true, force: true });
    }
  },
);
