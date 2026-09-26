import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import {
  projectApiRelayTransport,
  fetchWithProjectApiRelay,
} from "./api-relay";
import {
  API_RELAY_PATH,
  API_RELAY_PROJECT_HEADER,
  API_RELAY_SECRET_HEADER,
} from "@cocalc/conat/project-host/api-relay";

const projectId = "11111111-1111-4111-8111-111111111111";
const env: NodeJS.ProcessEnv = {
  COCALC_API_RELAY: "1",
  COCALC_API_RELAY_HUB_URL: "https://site.example/site",
  COCALC_PROJECT_ID: projectId,
  COCALC_PROJECT_SECRET: "local-secret",
  CONAT_SERVER: "http://10.206.0.1:9102/",
};

test("relay transport changes only the configured site's address", () => {
  assert.equal(
    projectApiRelayTransport({
      env,
      apiBaseUrl: "https://another-site.example",
    }),
    undefined,
  );
  assert.equal(
    projectApiRelayTransport({
      env: {},
      apiBaseUrl: env.COCALC_API_RELAY_HUB_URL!,
    }),
    undefined,
  );
  assert.deepEqual(
    projectApiRelayTransport({
      env,
      apiBaseUrl: env.COCALC_API_RELAY_HUB_URL!,
    }),
    {
      address: `http://10.206.0.1:9102${API_RELAY_PATH}/hub`,
      extraHeaders: {
        [API_RELAY_PROJECT_HEADER]: projectId,
        [API_RELAY_SECRET_HEADER]: "local-secret",
      },
    },
  );
});

test("host relay URLs carry identifiers, never a caller-chosen upstream", () => {
  const host = {
    host_id: "22222222-2222-4222-8222-222222222222",
    project_id: projectId,
  };
  const result = projectApiRelayTransport({
    env,
    apiBaseUrl: env.COCALC_API_RELAY_HUB_URL!,
    host,
  });
  assert.equal(
    result?.address,
    `http://10.206.0.1:9102${API_RELAY_PATH}/host/${host.host_id}/${host.project_id}`,
  );
});

test("a configured relay fails explicitly without its local project credential", () => {
  assert.throws(
    () =>
      projectApiRelayTransport({
        env: { ...env, COCALC_PROJECT_SECRET: "" },
        apiBaseUrl: env.COCALC_API_RELAY_HUB_URL!,
      }),
    /requires/,
  );
});

test("HTTP transport retains canonical paths and original credentials and rejects redirects", async () => {
  const saved = { ...process.env };
  const seen: Array<{ url?: string; authorization?: string; secret?: string }> =
    [];
  const server = createServer((req, res) => {
    seen.push({
      url: req.url,
      authorization: req.headers.authorization,
      secret: req.headers[API_RELAY_SECRET_HEADER] as string,
    });
    if (req.url?.endsWith("redirect")) {
      res.writeHead(302, { Location: "https://forbidden.invalid/" }).end();
    } else res.end("ok");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    Object.assign(process.env, env, {
      CONAT_SERVER: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    const response = await fetchWithProjectApiRelay(
      "https://site.example/site/api/v2/auth/status?check=1",
      { headers: { Authorization: "Bearer caller" } },
    );
    assert.equal(await response.text(), "ok");
    assert.deepEqual(seen[0], {
      url: `${API_RELAY_PATH}/hub/api/v2/auth/status?check=1`,
      authorization: "Bearer caller",
      secret: "local-secret",
    });
    await assert.rejects(
      fetchWithProjectApiRelay("https://site.example/site/api/v2/redirect"),
      /refused an HTTP redirect/,
    );
    assert.equal(seen.length, 2);
  } finally {
    for (const name of Object.keys(process.env))
      if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
