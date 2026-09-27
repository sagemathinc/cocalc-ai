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

test("local CLI data commands do not require a reachable hub", async () => {
  let hubRequests = 0;
  let localConnections = 0;
  const hub = createServer((_req, res) => {
    hubRequests++;
    res.writeHead(503).end();
  });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  const local = init({
    port: 0,
    getUser: async (socket) => {
      assert.equal(socket.handshake.auth.bearer, "caller-token");
      assert.equal(socket.handshake.auth.project_id, projectId);
      localConnections++;
      return { account_id: accountId };
    },
  });
  const home = await mkdtemp(join(tmpdir(), "project-local-data-"));
  // Exercise the real CLI context setup and network handshake, substituting
  // only the application services rather than running kernels/build tools.
  const fixture = `
    const assert = require('node:assert/strict');
    const check = (opts) => {
      assert.equal(opts.client.isSignedIn(), true);
      assert.equal(opts.project_id, ${JSON.stringify(projectId)});
    };
    require('@cocalc/conat/project/api/project-client').projectApiClient = (opts) => {
      check(opts);
      return {
        jupyter: { getKernelStatus: async () => ({backend_state:'running', kernel_state:'idle'}) },
        documentBuild: {
          capabilities: async () => ({ extensions: ['tex'] }),
          start: async () => ({ build_id:'test-build', state:'succeeded', stages:[], artifacts:[], diagnostics:[], path:'/home/user/test.tex' })
        }
      };
    };
    require('@cocalc/conat/project/terminal').terminalClient = (opts) => {
      check(opts); return {list: async () => ['test-terminal'], close() {}};
    };
    require('@cocalc/conat/files/fs').fsClient = (opts) => {
      assert.equal(opts.client.isSignedIn(), true);
      return { readFile: async () => 'local file' };
    };
    process.argv.splice(1, 0, ${JSON.stringify(resolve(__dirname, "../cocalc.js"))});
    require(${JSON.stringify(resolve(__dirname, "../cocalc.js"))});
  `;
  const commands = [
    ["project", "jupyter", "status", "--path", "/home/user/test.ipynb"],
    ["project", "terminal", "list"],
    ["project", "file", "cat", "/home/user/test.txt"],
    ["project", "build", "/home/user/test.tex", "--detach"],
    ["exec", "return { ready: true }"],
  ];
  try {
    for (const command of commands) {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "-e",
          fixture,
          "--",
          "--json",
          "--no-daemon",
          "--timeout",
          "2s",
          ...command,
        ],
        {
          timeout: 15_000,
          cwd: resolve(__dirname, "../../.."),
          env: {
            PATH: process.env.PATH,
            HOME: home,
            COCALC_PROFILE: "_env",
            COCALC_CLI_AGENT_MODE: "1",
            COCALC_PROJECT_ID: projectId,
            COCALC_BEARER_TOKEN: "caller-token",
            CONAT_SERVER: local.address(),
            COCALC_API_URL: `http://127.0.0.1:${(hub.address() as { port: number }).port}`,
            DEBUG_CONSOLE: "no",
            DEBUG_FILE: "",
          },
        },
      );
      assert.equal(JSON.parse(stdout).ok, true, command.join(" "));
    }
    assert.equal(hubRequests, 0);
    assert.equal(localConnections, commands.length);
  } finally {
    await local.close();
    hub.closeAllConnections();
    await new Promise<void>((done) => hub.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
});
