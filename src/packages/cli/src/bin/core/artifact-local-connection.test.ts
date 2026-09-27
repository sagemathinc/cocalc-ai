import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { init } from "@cocalc/conat/core/server";

const projectId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const messageDate = "2026-09-26T05:18:10.980Z";

test("artifact CLI connects only to the local project service when the hub is unreachable", async () => {
  let hubRequests = 0;
  let projectConnections = 0;
  const hub = createServer((_req, res) => {
    hubRequests++;
    res.writeHead(503).end();
  });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  const hubPort = (hub.address() as { port: number }).port;
  const local = init({
    port: 0,
    getUser: async (socket) => {
      assert.equal(socket.handshake.auth.bearer, "local-test-credential");
      assert.equal(socket.handshake.auth.project_id, projectId);
      projectConnections++;
      return { account_id: accountId };
    },
  });
  const home = await mkdtemp(join(tmpdir(), "artifact-local-connection-"));
  // Exercise the real CLI entrypoint and Conat handshake. Only the chat store
  // is in-memory; no live project or external account credentials are used.
  const fixture = `
    const store = require('@cocalc/chat/server');
    const rows = [{event:'chat', thread_id:${JSON.stringify(threadId)},
      message_id:${JSON.stringify(messageId)}, date:${JSON.stringify(messageDate)}}];
    const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
    store.acquireChatSyncDB = async ({client, project_id}) => {
      require('node:assert/strict').equal(project_id, ${JSON.stringify(projectId)});
      require('node:assert/strict').equal(client.isSignedIn(), true);
      return {
        get: () => rows,
        get_one: (where) => rows.find(row => matches(row, where)),
        set: (value) => rows.push(...(Array.isArray(value) ? value : [value])),
        commit() {}, save: async () => {}, save_to_disk: async () => {}
      };
    };
    store.releaseChatSyncDB = async () => {};
    process.argv.splice(1, 0, ${JSON.stringify(resolve(__dirname, "../cocalc.js"))});
    require(${JSON.stringify(resolve(__dirname, "../cocalc.js"))});
  `;
  try {
    for (const action of ["context", "publish"]) {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "-e",
          fixture,
          "--",
          "--timeout",
          "2s",
          "project",
          "chat",
          "artifact",
          action,
          "--path",
          "/home/user/.local/share/cocalc/agents/agent.chat",
          "--thread-id",
          threadId,
          "--message-date",
          messageDate,
          ...(action === "publish"
            ? ["--source", "/home/user/sin-x-squared.png"]
            : []),
        ],
        {
          cwd: resolve(__dirname, "../../.."),
          timeout: 15_000,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            COCALC_PROFILE: "_env",
            COCALC_CLI_AGENT_MODE: "1",
            COCALC_WORKBENCH: "1",
            COCALC_PROJECT_ID: projectId,
            COCALC_API_URL: `http://127.0.0.1:${hubPort}`,
            CONAT_SERVER: local.address(),
            COCALC_BEARER_TOKEN: "local-test-credential",
            DEBUG_CONSOLE: "no",
            DEBUG_FILE: "",
          },
        },
      );
      const result = JSON.parse(stdout);
      assert.equal(result.ok, true);
      assert.equal(result.data.message_id, messageId);
      if (action === "publish") {
        assert.equal(
          result.data.current.artifact.file.path,
          "/home/user/sin-x-squared.png",
        );
        assert.equal(result.data.publication.message_id, messageId);
      }
    }
    assert.equal(hubRequests, 0);
    assert.equal(projectConnections, 2);
  } finally {
    await local.close();
    hub.closeAllConnections();
    await new Promise<void>((done) => hub.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
});
