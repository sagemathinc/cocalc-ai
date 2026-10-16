/*
A paired computer on its project's host, end to end: a real Conat server with
the project-host authorization, real host tokens (signed and verified), the
real connector running real commands, and the project's own processes asking
it. Design: src/.agents/computers-direct-host-2026-10-16.md.

pnpm test `pwd`/computers.e2e.test.ts
*/

import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const keys = generateKeyPairSync("ed25519");
const PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" });
const PRIVATE_KEY = keys.privateKey.export({ type: "pkcs8", format: "pem" });

const ACCOUNT_ID = "00000000-1000-4000-8000-000000000001";
const STRANGER_ID = "00000000-1000-4000-8000-000000000002";
const PROJECT_ID = "00000000-1000-4000-8000-000000000010";
const OTHER_PROJECT_ID = "00000000-1000-4000-8000-000000000011";
const HOST_ID = "00000000-1000-4000-8000-000000000099";
const SECRET = "project-secret";

// The host's database, shared by its processes: this test process is the
// conat router; revocations and the switch are written by another process,
// as the master writes them in production.
const SQLITE_DIR = mkdtempSync(join(tmpdir(), "computers-host-db-"));
process.env.COCALC_LITE_SQLITE_FILENAME = join(SQLITE_DIR, "host.db");

/** Run f in a separate node process against the same host database. */
function inMasterProcess(code: string): void {
  execFileSync(
    process.execPath,
    [
      "-e",
      `const c = require(${JSON.stringify(join(__dirname, "dist", "computers.js"))}); ${code}`,
    ],
    { env: process.env, stdio: "pipe", timeout: 30_000 },
  );
}

// The host's copy of each project's collaborators: tests change it.
const mockProjects: Record<string, any> = {};
jest.mock("./sqlite/projects", () => ({
  getProject: (project_id: string) => mockProjects[project_id],
}));
jest.mock("@cocalc/lite/hub/sqlite/database", () => ({
  ...jest.requireActual("@cocalc/lite/hub/sqlite/database"),
  getRow: (_table: string, key: string) =>
    mockProjects[JSON.parse(key).project_id],
}));
jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("./auth-public-key", () => ({
  getProjectHostAuthPublicKey: () => PUBLIC_KEY,
}));
jest.mock("./sqlite/account-revocations", () => ({
  getAccountRevokedBeforeMs: () => undefined,
}));
jest.mock("./master-status", () => ({
  getMasterConatClient: () => undefined,
}));
jest.mock("./managed-egress-runtime", () => ({
  getProjectHostManagedEgressBlockedMessage: () => undefined,
}));

import { initConatServer } from "@cocalc/backend/conat/test/setup";
import { connect, type Client } from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";
import {
  issueProjectHostAuthToken,
  issueProjectHostComputerToken,
} from "@cocalc/conat/auth/project-host-token";
import {
  computerExecSubject,
  computerHelloSubject,
} from "@cocalc/conat/computers/subjects";
import {
  RevokedError,
  runConnector,
  type Connection,
} from "@cocalc/backend/computers/connector";
import type { HostConnection } from "@cocalc/util/computers/api";
import { createProjectHostConatAuth } from "./conat-auth";
import {
  resetComputerAccessForTesting,
  setComputersEnabledOnHost,
} from "./sqlite/computer-access";

jest.setTimeout(60_000);

function soloProject(owner = ACCOUNT_ID) {
  return {
    project_id: PROJECT_ID,
    secret_token: SECRET,
    users: { [owner]: { group: "owner" } },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(
  f: () => boolean | Promise<boolean>,
  what: string,
  timeout = 15_000,
): Promise<void> {
  const start = Date.now();
  while (!(await f())) {
    if (Date.now() - start > timeout) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("a computer on its project's host", () => {
  let server;
  const clients: Client[] = [];
  const dirs: string[] = [];

  function client(auth: object): Client {
    const c = connect({
      address: server.address(),
      noCache: true,
      reconnection: false,
      auth: (cb) => cb(auth),
    });
    c.inboxPrefixHook = (info) =>
      info?.user ? inboxPrefix(info.user as any) : undefined;
    clients.push(c);
    return c;
  }

  /** A process in the project (the CLI with the project's secret). */
  const project = () =>
    client({ project_id: PROJECT_ID, project_secret: SECRET });

  /** An agent in the project (its host token is bound to the project). */
  const agent = (project_id = PROJECT_ID) =>
    client({
      bearer: issueProjectHostAuthToken({
        host_id: HOST_ID,
        account_id: ACCOUNT_ID,
        project_id,
        auth_actor: "agent",
        private_key: PRIVATE_KEY,
      }).token,
    });

  /** The owner's browser. */
  const human = () =>
    client({
      bearer: issueProjectHostAuthToken({
        host_id: HOST_ID,
        account_id: ACCOUNT_ID,
        private_key: PRIVATE_KEY,
      }).token,
    });

  function computerToken(computer_id: string, ttl_seconds?: number) {
    return issueProjectHostComputerToken({
      host_id: HOST_ID,
      computer_id,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      private_key: PRIVATE_KEY,
      ...(ttl_seconds ? { ttl_seconds } : {}),
    });
  }

  /** The real connector, with the hub's answer simulated. */
  function startComputer({
    refreshMs,
    revoked = () => false,
  }: { refreshMs?: number; revoked?: () => boolean } = {}) {
    const computer_id = randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "computer-"));
    dirs.push(dir);
    const connection: Connection = {
      dir,
      origin: "http://localhost",
      computer_id,
      name: `m${dirs.length}`,
      project_id: PROJECT_ID,
      token: "x".repeat(43),
    };
    const logs: string[] = [];
    let connects = 0;
    const stop = new AbortController();
    const done = runConnector({
      connection,
      io: { log: (m) => logs.push(m), confirm: async () => true },
      signal: stop.signal,
      refreshMs,
      hostConnection: async (): Promise<HostConnection> => {
        if (revoked()) throw new RevokedError("revoked in CoCalc");
        const { token, expires_at } = computerToken(computer_id);
        return {
          computer_id,
          project_id: PROJECT_ID,
          host_id: HOST_ID,
          address: server.address(),
          token,
          expires_at,
        };
      },
      onConnected: () => {
        connects += 1;
      },
    });
    return {
      computer_id,
      name: connection.name,
      logs,
      done,
      stop: () => stop.abort(),
      connects: () => connects,
    };
  }

  async function exec(
    c: Client,
    computer_id: string,
    request: object,
    timeout = 20_000,
  ): Promise<any> {
    const mesg = await c.request(
      computerExecSubject(PROJECT_ID, computer_id),
      { v: 1, request },
      { timeout },
    );
    return mesg.data;
  }

  beforeAll(async () => {
    const auth = createProjectHostConatAuth({ host_id: HOST_ID });
    server = await initConatServer({
      getUser: auth.getUser,
      isAllowed: auth.isAllowed,
      computerRevalidationMs: 300,
    });
  });

  beforeEach(() => {
    resetComputerAccessForTesting();
    setComputersEnabledOnHost(true);
    mockProjects[PROJECT_ID] = soloProject();
    mockProjects[OTHER_PROJECT_ID] = {
      ...soloProject(),
      project_id: OTHER_PROJECT_ID,
    };
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await server?.close();
    for (const dir of [...dirs, SQLITE_DIR]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs a command for the project's processes and agents, and says hello", async () => {
    const m = startComputer();
    await until(() => m.connects() > 0, "the computer connects");
    const p = project();
    const r = await exec(p, m.computer_id, {
      command: "echo hi; echo err >&2",
    });
    expect(r).toMatchObject({
      ok: true,
      result: { exit_code: 0, stdout: "hi\n", stderr: "err\n" },
    });
    // argv is exact: no shell parses its values.
    const a = await exec(agent(), m.computer_id, {
      argv: ["printf", "%s|", "a b", "$HOME", "it's"],
    });
    expect(a.result.stdout).toBe("a b|$HOME|it's|");
    // A malformed request is refused there, not run.
    expect(await exec(p, m.computer_id, { command: "" })).toMatchObject({
      ok: false,
    });
    // hello: every connected computer of the project answers once.
    const sub = await p.requestMany(
      computerHelloSubject(PROJECT_ID),
      { v: 1 },
      { maxWait: 1000 },
    );
    const hellos: any[] = [];
    for await (const mesg of sub) hellos.push(mesg.data);
    expect(hellos.map((h) => h.computer_id)).toEqual([m.computer_id]);
    expect(hellos[0]).toMatchObject({ v: 1, name: m.name });
    m.stop();
    await m.done;
  });

  it("serves no one else: other projects, browsers, and itself beyond its subjects", async () => {
    const m = startComputer();
    await until(() => m.connects() > 0, "the computer connects");
    const subject = computerExecSubject(PROJECT_ID, m.computer_id);
    // Another project's agent may not ask it.
    await expect(
      agent(OTHER_PROJECT_ID).request(
        subject,
        { v: 1, request: { command: "id" } },
        { timeout: 3000 },
      ),
    ).rejects.toThrow();
    // The owner's browser may neither ask it nor pose as it.
    const h = human();
    await expect(
      h.request(
        subject,
        { v: 1, request: { command: "id" } },
        { timeout: 3000 },
      ),
    ).rejects.toThrow();
    await expect(h.subscribe(subject)).rejects.toThrow();
    // The project itself may ask, but never receive there.
    await expect(project().subscribe(subject)).rejects.toThrow();
    // A computer token: only its own subjects.
    const self = client({ bearer: computerToken(m.computer_id).token });
    await expect(
      self.subscribe(computerExecSubject(PROJECT_ID, randomUUID())),
    ).rejects.toThrow();
    await expect(
      self.subscribe(computerHelloSubject(OTHER_PROJECT_ID)),
    ).rejects.toThrow();
    await expect(
      self.publish(`project.${PROJECT_ID}.api`, "x"),
    ).rejects.toThrow();
    m.stop();
    await m.done;
  });

  it("keeps answering across reconnections, including a command started before", async () => {
    const m = startComputer({ refreshMs: 1500 });
    await until(() => m.connects() > 0, "the computer connects");
    const p = project();
    const slow = exec(p, m.computer_id, { command: "sleep 3; echo slow" });
    await until(() => m.connects() >= 3, "two reconnections", 20_000);
    expect((await slow).result.stdout).toBe("slow\n");
    expect(
      (await exec(p, m.computer_id, { command: "echo after" })).result.stdout,
    ).toBe("after\n");
    m.stop();
    await m.done;
  });

  it("revoked: the host drops it, its running command is stopped, and the connector ends", async () => {
    let revoked = false;
    const m = startComputer({ revoked: () => revoked });
    await until(() => m.connects() > 0, "the computer connects");
    const pidFile = join(dirs[dirs.length - 1], "pid");
    const pending = exec(
      project(),
      m.computer_id,
      { command: `echo $$ > ${pidFile}; exec sleep 30` },
      5_000,
    ).catch((err) => ({ error: `${err}` }));
    await until(() => existsSync(pidFile), "the command starts");
    const pid = Number(readFileSync(pidFile, "utf8"));
    const started = Date.now();
    revoked = true;
    // The hub's dropComputer reaches the master, another process.
    inMasterProcess(`c.dropComputer(${JSON.stringify(m.computer_id)})`);
    await m.done; // it ends for good
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(m.logs.join("\n")).toMatch(/revoked/);
    // The command was stopped, not left running, and no answer came.
    await until(() => !alive(pid), "the command is stopped");
    expect(await pending).toHaveProperty("error");
    // And a token issued before can't get it back in.
    const again = client({ bearer: computerToken(m.computer_id).token });
    await expect(again.waitUntilSignedIn({ timeout: 3000 })).rejects.toThrow();
  });

  it("a collaborator added to the project cuts the computer off at once", async () => {
    const m = startComputer();
    await until(() => m.connects() > 0, "the computer connects");
    const p = project();
    expect((await exec(p, m.computer_id, { command: "true" })).ok).toBe(true);
    mockProjects[PROJECT_ID].users[STRANGER_ID] = { group: "collaborator" };
    await until(
      async () =>
        (await exec(p, m.computer_id, { command: "true" }, 2000).catch(
          () => "refused",
        )) === "refused",
      "the computer stops answering",
    );
    // Nor can it connect again while the collaborator is there.
    const again = client({ bearer: computerToken(m.computer_id).token });
    await expect(again.waitUntilSignedIn({ timeout: 3000 })).rejects.toThrow();
    m.stop();
    await m.done;
  });

  it("the site's switch turned off (heard by the master): computers are cut off and refused", async () => {
    const m = startComputer();
    await until(() => m.connects() > 0, "the computer connects");
    const p = project();
    expect((await exec(p, m.computer_id, { command: "true" })).ok).toBe(true);
    inMasterProcess(`c.applyComputerAccess({ enabled: false, revoked: [] })`);
    await until(
      async () =>
        (await exec(p, m.computer_id, { command: "true" }, 2000).catch(
          () => "refused",
        )) === "refused",
      "the computer stops answering",
    );
    const again = client({ bearer: computerToken(m.computer_id).token });
    await expect(again.waitUntilSignedIn({ timeout: 3000 })).rejects.toThrow();
    m.stop();
    await m.done;
  });

  it("a revocation the status sync reports is enforced like a dropComputer call", async () => {
    const m = startComputer();
    await until(() => m.connects() > 0, "the computer connects");
    inMasterProcess(
      `c.applyComputerAccess({ enabled: true, revoked: [${JSON.stringify(m.computer_id)}] })`,
    );
    const again = client({ bearer: computerToken(m.computer_id).token });
    await expect(again.waitUntilSignedIn({ timeout: 3000 })).rejects.toThrow();
    m.stop();
    await m.done;
  });

  it("refuses an expired computer token", async () => {
    const { token } = issueProjectHostComputerToken({
      host_id: HOST_ID,
      computer_id: randomUUID(),
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      private_key: PRIVATE_KEY,
      now_ms: Date.now() - 20 * 60 * 1000,
    });
    const c = client({ bearer: token });
    await expect(c.waitUntilSignedIn({ timeout: 3000 })).rejects.toThrow();
  });
});
