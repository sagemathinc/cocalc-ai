import assert from "node:assert/strict";
import test from "node:test";

import {
  createHostHelpers,
  normalizeHostSoftwareArtifactValue,
  parseHostSoftwareArtifactsOption,
} from "./host-helpers";

function sshHelpers(
  host: Record<string, any>,
  lookupHost = async (_hostname: string) => ({ address: "10.0.0.2" }),
) {
  return createHostHelpers({
    listHosts: async () => [],
    resolveHost: async () => ({ id: "host-1", ...host }),
    parseSshServer: () => {
      throw new Error("must not use project SSH routing");
    },
    cliDebug: () => {},
    lookupHost,
    hostSshResolveTimeoutMs: 10,
  });
}

test("SSH auto uses private DNS, not the internal HTTP port or project SSH proxy", async () => {
  const result = await sshHelpers({
    internal_url: "http://host.example.internal:9002",
    public_ip: "192.0.2.1",
    ssh_server: "192.0.2.1:2222",
  }).resolveHostSshEndpoint({}, "host-1");
  assert.equal(result.network, "private");
  assert.equal(result.ssh_host, "host.example.internal");
  assert.equal(result.resolved_ip, "10.0.0.2");
  assert.equal(result.ssh_port, 22);
});

test("SSH public selection does not perform private DNS lookup", async () => {
  const result = await sshHelpers(
    {
      internal_url: "http://host.internal:9002",
      public_ip: "192.0.2.1",
      machine: { metadata: { ssh_port: 2200 } },
    },
    async () => {
      throw new Error("unexpected lookup");
    },
  ).resolveHostSshEndpoint({}, "host-1", "public");
  assert.equal(result.ssh_host, "192.0.2.1");
  assert.equal(result.ssh_port, 2200);
  assert.equal(result.network, "public");
});

test("SSH private selection fails closed for absent, malformed and unresolvable metadata", async () => {
  for (const internal_url of [
    undefined,
    "not a URL",
    "http://missing.internal:9002",
  ]) {
    await assert.rejects(
      sshHelpers(
        {
          internal_url,
          public_ip: "192.0.2.1",
        },
        async () => {
          throw new Error("DNS failed");
        },
      ).resolveHostSshEndpoint({}, "host-1", "private"),
      /refusing public fallback/,
    );
  }
});

test("SSH uses provider private IP when internal DNS fails, including IPv6", async () => {
  for (const private_ip of ["10.0.0.2", "fd00::2"]) {
    const result = await sshHelpers(
      {
        internal_url: "http://missing.internal:9002",
        private_ip,
      },
      async () => {
        throw new Error("DNS failed");
      },
    ).resolveHostSshEndpoint({}, "host-1", "private");
    assert.equal(result.ssh_host, private_ip);
    assert.equal(result.network, "private");
    assert.equal(
      result.ssh_server,
      private_ip.includes(":") ? "[fd00::2]:22" : "10.0.0.2:22",
    );
  }
});

test("SSH auto DNS timeout is bounded and explains public fallback", async () => {
  const result = await sshHelpers(
    {
      internal_url: "http://missing.internal:9002",
      public_ip: "192.0.2.1",
    },
    () => new Promise(() => {}),
  ).resolveHostSshEndpoint({}, "host-1", "auto");
  assert.equal(result.network, "public");
  assert.match(result.selection_reason, /timed out/);
});

test("SSH rejects invalid network and never falls back to project SSH", async () => {
  const helpers = sshHelpers({ ssh_server: "192.0.2.1:2222" });
  await assert.rejects(
    helpers.resolveHostSshEndpoint({}, "host-1", "invalid"),
    /--network/,
  );
  await assert.rejects(
    helpers.resolveHostSshEndpoint({}, "host-1"),
    /no administrative SSH endpoint/,
  );
});

test("container runtime host upgrades are explicit-only", () => {
  assert.equal(
    normalizeHostSoftwareArtifactValue("podman"),
    "container-runtime",
  );
  assert.deepEqual(parseHostSoftwareArtifactsOption(), [
    "project-host",
    "project",
    "tools",
  ]);
  assert.deepEqual(parseHostSoftwareArtifactsOption(["container-runtime"]), [
    "container-runtime",
  ]);
});

test("waitForHostCreateReady waits for a heartbeat after running status", async () => {
  let calls = 0;
  const helpers = createHostHelpers({
    listHosts: async () => {
      calls += 1;
      if (calls === 1) {
        return [{ id: "host-1", status: "running" }];
      }
      return [
        {
          id: "host-1",
          status: "running",
          last_seen: "2026-03-18T14:00:00.000Z",
        },
      ];
    },
    resolveHost: async () => {
      throw new Error("not used in this test");
    },
    parseSshServer: () => ({ host: "127.0.0.1", port: 22 }),
    cliDebug: () => {},
  });

  const result = await helpers.waitForHostCreateReady({} as any, "host-1", {
    timeoutMs: 50,
    pollMs: 0,
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.host.id, "host-1");
  assert.equal(calls, 2);
});

test("waitForHostCreateReady reports bootstrap progress changes", async () => {
  let calls = 0;
  const progress: Array<{
    status: string;
    bootstrapStatus?: string;
    bootstrapMessage?: string;
    hasHeartbeat: boolean;
  }> = [];
  const helpers = createHostHelpers({
    listHosts: async () => {
      calls += 1;
      if (calls === 1) {
        return [
          {
            id: "host-1",
            status: "starting",
            bootstrap: {
              status: "queued",
              message: "Waiting for cloud host bootstrap",
            },
          },
        ];
      }
      if (calls === 2) {
        return [
          {
            id: "host-1",
            status: "running",
            bootstrap: {
              status: "running",
              message: "Installing Ubuntu packages",
            },
          },
        ];
      }
      return [
        {
          id: "host-1",
          status: "running",
          last_seen: "2026-03-18T14:00:00.000Z",
          bootstrap: {
            status: "done",
            message: "Bootstrap completed",
          },
        },
      ];
    },
    resolveHost: async () => {
      throw new Error("not used in this test");
    },
    parseSshServer: () => ({ host: "127.0.0.1", port: 22 }),
    cliDebug: () => {},
  });

  const result = await helpers.waitForHostCreateReady({} as any, "host-1", {
    timeoutMs: 50,
    pollMs: 0,
    onProgress: (update) => {
      progress.push({
        status: update.status,
        bootstrapStatus: update.bootstrapStatus,
        bootstrapMessage: update.bootstrapMessage,
        hasHeartbeat: update.hasHeartbeat,
      });
    },
  });

  assert.equal(result.timedOut, false);
  assert.deepEqual(progress, [
    {
      status: "starting",
      bootstrapStatus: "queued",
      bootstrapMessage: "Waiting for cloud host bootstrap",
      hasHeartbeat: false,
    },
    {
      status: "running",
      bootstrapStatus: "running",
      bootstrapMessage: "Installing Ubuntu packages",
      hasHeartbeat: false,
    },
    {
      status: "running",
      bootstrapStatus: "done",
      bootstrapMessage: "Bootstrap completed",
      hasHeartbeat: true,
    },
  ]);
});
