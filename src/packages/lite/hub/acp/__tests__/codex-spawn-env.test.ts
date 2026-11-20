/*
 * The environment a spawned Codex app-server actually receives.
 *
 * A stub `codex` (a small Node script) is launched through the production
 * entry points:
 *  - the Lite turn path: buildCodexRuntimeEnv, then spawnLiteCodexAppServer
 *    (as lite/hub/acp/index.ts does for a turn);
 *  - the standalone path: getCodexAppServerAccountStatus with no project
 *    spawner installed and no projectId, which falls back to the standalone
 *    spawn.
 * The stub writes the NAMES of its environment variables (never values) and
 * probes a local HTTP endpoint that checks the bearer token, once with its
 * environment and once with both token variables removed.
 *
 * Only the credential and payment lookups are mocked (and the hub API, which
 * is not reached because a token is already set). Limits: this does not run a
 * real Codex binary, and the probe is a local test endpoint, not a CoCalc hub.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "synthetic-test-token-not-a-credential";
const PROJECT = "00000000-0000-4000-8000-0000000000aa";
const ACCOUNT = "00000000-0000-4000-8000-0000000000bb";

let dir = "";
jest.mock("../../codex-credentials", () => ({
  resolveLiteCodexHome: () => join(dir, "codex-home"),
  validateLiteSubscriptionAuth: () => undefined,
  getLiteCliApiKey: () => undefined,
  getLiteCredential: () => undefined,
  touchLiteCredential: () => undefined,
  refreshLiteCredential: async () => undefined,
}));
jest.mock("../../codex-payment", () => ({
  getLiteCodexPaymentSource: async () => ({ source: "account-api-key" }),
  getLiteCodexApiKeys: () => ({
    "account-api-key": "synthetic-dummy-key-not-a-credential",
  }),
}));
jest.mock("../../api", () => ({ hubApi: {} }));

const INTERNAL = {
  CONAT_SERVER: "http://127.0.0.1:1",
  COCALC_LITE_ACP_WORKER_CONAT_PASSWORD: "internal-test-value",
  COCALC_LITE_ACP_WORKER: "1",
  COCALC_SOME_FUTURE_SECRET_TEST: "internal-test-value",
  MASTER_CONAT_SERVER: "http://127.0.0.1:1",
  DATA: "/nonexistent-data",
  COCALC_TEST_CANARY: "1",
};

let server: Server;
let apiUrl = "";
const saved: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  }
}

function writeStub(name: string): {
  stub: string;
  names: string;
  probe: string;
} {
  const names = join(dir, `${name}.names`);
  const probe = join(dir, `${name}.probe.json`);
  const stub = join(dir, `${name}-codex`);
  writeFileSync(
    stub,
    `#!${process.execPath}
const fs = require("fs");
const http = require("http");
fs.writeFileSync(${JSON.stringify(names)}, Object.keys(process.env).sort().join("\\n") + "\\n");
function probe(env) {
  return new Promise((resolve) => {
    const headers = env.COCALC_AGENT_TOKEN ? { authorization: "Bearer " + env.COCALC_AGENT_TOKEN } : {};
    const req = http.get(env.COCALC_API_URL + "/probe", { headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, reason: body }));
    });
    req.on("error", () => resolve({ status: 0, reason: "connection-error" }));
  });
}
(async () => {
  const withToken = await probe(process.env);
  const stripped = { ...process.env };
  delete stripped.COCALC_AGENT_TOKEN;
  delete stripped.COCALC_BEARER_TOKEN;
  const withoutToken = await probe(stripped);
  fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ withToken, withoutToken }));
  process.exit(1);
})();
`,
  );
  chmodSync(stub, 0o700);
  return { stub, names, probe };
}

async function waitFor(path: string, ms = 20_000): Promise<void> {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > ms) throw Error(`stub did not write ${path}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function count(namesFile: string, key: string): number {
  return readFileSync(namesFile, "utf8")
    .split("\n")
    .filter((line) => line === key).length;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "codex-spawn-env-"));
  server = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (!auth) {
      res.statusCode = 401;
      res.end("missing-token");
    } else if (auth !== `Bearer ${TOKEN}`) {
      res.statusCode = 403;
      res.end("wrong-token");
    } else {
      res.end("ok");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  apiUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  setEnv({
    ...INTERNAL,
    TEST_PLAIN_CANARY: "1",
    COCALC_API_URL: apiUrl,
    COCALC_AGENT_TOKEN: TOKEN,
  });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function expectInternalAbsent(names: string) {
  for (const key of Object.keys(INTERNAL)) {
    expect({ key, count: count(names, key) }).toEqual({ key, count: 0 });
  }
}

function expectTokenProbe(probeFile: string) {
  const { withToken, withoutToken } = JSON.parse(
    readFileSync(probeFile, "utf8"),
  );
  expect(withToken).toEqual({ status: 200, reason: "ok" });
  expect(withoutToken).toEqual({ status: 401, reason: "missing-token" });
}

describe("Codex app-server spawn environment", () => {
  it("Lite turn path: buildCodexRuntimeEnv -> spawnLiteCodexAppServer", async () => {
    const { stub, names, probe } = writeStub("lite");
    setEnv({ COCALC_CODEX_BIN: stub });
    const { buildCodexRuntimeEnv } = await import("../runtime-env");
    const { spawnLiteCodexAppServer } = await import("../../codex-runtime");
    const env = await buildCodexRuntimeEnv({
      request: {
        project_id: PROJECT,
        account_id: ACCOUNT,
        chat: { path: "a.chat", thread_id: "t1" },
      } as any,
      projectId: PROJECT,
      includeCliBin: false,
      useContainer: false,
    });
    const spawned = await spawnLiteCodexAppServer({
      projectId: PROJECT,
      accountId: ACCOUNT,
      cwd: dir,
      env,
    } as any);
    await waitFor(probe);
    spawned.proc.kill?.();
    // positive controls first: the stub ran and the plain twin survived
    expect(existsSync(names)).toBe(true);
    expect(count(names, "TEST_PLAIN_CANARY")).toBe(1);
    expectInternalAbsent(names);
    for (const key of [
      "COCALC_API_URL",
      "COCALC_AGENT_TOKEN",
      "COCALC_BEARER_TOKEN",
      "CODEX_HOME",
      "COCALC_CODEX_HOME",
    ]) {
      expect({ key, count: count(names, key) }).toEqual({ key, count: 1 });
    }
    expect(count(names, "OPENAI_API_KEY")).toBe(0);
    expectTokenProbe(probe);
  });

  it("standalone path: account status without a project spawner", async () => {
    const { stub, names, probe } = writeStub("standalone");
    const { getCodexAppServerAccountStatus } = await import("@cocalc/ai/acp");
    await getCodexAppServerAccountStatus({
      binaryPath: stub,
      cwd: dir,
      env: {
        COCALC_API_URL: apiUrl,
        COCALC_AGENT_TOKEN: TOKEN,
        COCALC_BEARER_TOKEN: TOKEN,
      },
      timeoutMs: 15_000,
    }).catch(() => undefined);
    await waitFor(probe);
    expect(existsSync(names)).toBe(true);
    expect(count(names, "TEST_PLAIN_CANARY")).toBe(1);
    expectInternalAbsent(names);
    for (const key of [
      "COCALC_API_URL",
      "COCALC_AGENT_TOKEN",
      "COCALC_BEARER_TOKEN",
    ]) {
      expect({ key, count: count(names, key) }).toEqual({ key, count: 1 });
    }
    expectTokenProbe(probe);
  });
});
