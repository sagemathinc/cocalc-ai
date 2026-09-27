import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { init } from "@cocalc/conat/core/server";

test("project collaborators supply project context when resolving a private host", async () => {
  const accountId = "22222222-2222-4222-8222-222222222222";
  const projectId = "33333333-3333-4333-8333-333333333333";
  const hostId = "44444444-4444-4444-8444-444444444444";
  const server = init({
    port: 0,
    getUser: async () => ({ account_id: accountId }),
  });
  const home = await mkdtemp(join(tmpdir(), "project-host-routing-"));
  const fixture = `
    const assert = require('node:assert/strict');
    let resolved = false;
    require('@cocalc/conat/hub/call-hub').default = async ({name, args}) => {
      if (name === 'db.userQuery') return {projects: [{
        project_id: ${JSON.stringify(projectId)},
        host_id: ${JSON.stringify(hostId)}, title: 'Shared project'
      }]};
      if (name === 'hosts.resolveHostConnection') {
        assert.deepEqual(args[0], {
          host_id: ${JSON.stringify(hostId)},
          project_id: ${JSON.stringify(projectId)}
        });
        resolved = true;
        return {connect_url: ${JSON.stringify(server.address())}};
      }
      if (name === 'hosts.issueProjectHostAuthToken') {
        assert.equal(args[0].project_id, ${JSON.stringify(projectId)});
        return {token: 'project-scoped-token', expires_at: Date.now()+60000};
      }
      throw Error('unexpected hub method: '+name);
    };
    require('@cocalc/conat/files/fs').fsClient = ({client}) => {
      assert.equal(resolved, true);
      assert.equal(client.isSignedIn(), true);
      return {readFile: async () => 'shared file'};
    };
    process.argv.splice(1, 0, ${JSON.stringify(resolve(__dirname, "../cocalc.js"))});
    require(${JSON.stringify(resolve(__dirname, "../cocalc.js"))});
  `;
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "-e",
        fixture,
        "--",
        "--json",
        "--no-daemon",
        "--timeout",
        "5s",
        "--api",
        server.address(),
        "project",
        "file",
        "cat",
        "--project",
        projectId,
        "/home/user/shared.txt",
      ],
      {
        timeout: 15_000,
        cwd: resolve(__dirname, "../../.."),
        env: {
          PATH: process.env.PATH,
          HOME: home,
          COCALC_PROFILE: "_env",
          COCALC_ACCOUNT_ID: accountId,
          DEBUG_CONSOLE: "no",
          DEBUG_FILE: "",
        },
      },
    );
    assert.equal(JSON.parse(stdout).ok, true);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
