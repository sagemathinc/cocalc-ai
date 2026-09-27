import assert from "node:assert/strict";
import test from "node:test";
import { openProjectOnlyContextConnection } from "./project-only-context";

const projectId = "11111111-1111-4111-8111-111111111111";
const defaults = {
  projectOnly: {},
  apiBaseUrl: "https://unreachable-hub.invalid",
  timeoutMs: 500,
  agentMode: true,
  explicitTransport: false,
  env: {
    COCALC_PROJECT_ID: projectId,
    CONAT_SERVER: "http://host.containers.internal:9102",
  },
};

test("project data commands connect locally without requiring hub sign-in", async () => {
  const connection = { projectId } as any;
  let calls = 0;
  for (const projectOnly of [{}, { projectIdentifier: projectId }]) {
    assert.equal(
      await openProjectOnlyContextConnection({
        ...defaults,
        projectOnly,
        connect: async (options) => {
          calls++;
          assert.deepEqual(options, {
            apiBaseUrl: defaults.apiBaseUrl,
            timeoutMs: 500,
            projectId,
          });
          return connection;
        },
      }),
      connection,
    );
  }
  assert.equal(calls, 2);
});

test("explicit site targets, other projects, and control-plane commands keep normal routing", async () => {
  for (const options of [
    { projectOnly: undefined },
    { agentMode: false },
    { explicitTransport: true },
    { explicitAuth: true },
    { disableEnvAuthDefaults: true },
    { projectOnly: { projectIdentifier: "other-project" } },
    { env: { ...defaults.env, COCALC_PROJECT_ID: "invalid" } },
    { env: { ...defaults.env, CONAT_SERVER: "" } },
  ]) {
    assert.equal(
      await openProjectOnlyContextConnection({
        ...defaults,
        ...options,
        connect: async () => {
          throw Error("unexpected local connection");
        },
      }),
      undefined,
    );
  }
});

test("local connection failures do not retry against the hub or change identity", async () => {
  let calls = 0;
  await assert.rejects(
    openProjectOnlyContextConnection({
      ...defaults,
      connect: async () => {
        calls++;
        throw Error("local authentication failed");
      },
    }),
    /local authentication failed/,
  );
  assert.equal(calls, 1);
});
