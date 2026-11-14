/*
The connection agents of project-host-target.ts, against real sockets: a name
that resolves to a refused address is refused at connect time, the checked
address is the one connected to (no second lookup), and nothing reaches the
target or a proxy when a connection is refused.
*/

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  REFUSED_TARGET_CODE,
  createProjectHostAgent,
  guardedLookup,
  isBayTunnelAddress,
  projectHostAgentFor,
} from "./project-host-target";

type Answer = { address: string; family: number };

// A resolver with fixed answers that counts its calls.
function fakeLookup(table: Record<string, Answer[]>) {
  const calls: string[] = [];
  const lookup: any = (hostname: string, options: any, callback: any) => {
    calls.push(hostname);
    const answers = table[hostname];
    if (!answers) {
      const err: any = new Error(`ENOTFOUND ${hostname}`);
      err.code = "ENOTFOUND";
      process.nextTick(callback, err);
      return;
    }
    if (options?.all) {
      process.nextTick(callback, null, answers);
    } else {
      process.nextTick(callback, null, answers[0].address, answers[0].family);
    }
  };
  return { lookup, calls };
}

const LOOP: Answer = { address: "127.0.0.1", family: 4 };
const META: Answer = { address: "169.254.169.254", family: 4 };
const PUB: Answer = { address: "34.82.1.2", family: 4 };

function run(
  hook: ReturnType<typeof guardedLookup>,
  name: string,
  options: any = {},
): Promise<{ err?: any; result?: any }> {
  return new Promise((resolve) => {
    hook(name, options, (err: any, address: any, family: any) => {
      resolve(
        err ? { err } : { result: options.all ? address : { address, family } },
      );
    });
  });
}

describe("guardedLookup", () => {
  it("checks EVERY resolved address, in both callback forms", async () => {
    const { lookup } = fakeLookup({
      "mixed.test": [PUB, LOOP],
      "public.test": [PUB],
      "meta.test": [META],
      "six.test": [{ address: "::ffff:127.0.0.1", family: 6 }],
    });
    const hook = guardedLookup({ lookup });
    for (const all of [false, true]) {
      expect((await run(hook, "mixed.test", { all })).err?.code).toBe(
        REFUSED_TARGET_CODE,
      );
      expect((await run(hook, "meta.test", { all })).err?.code).toBe(
        REFUSED_TARGET_CODE,
      );
      expect((await run(hook, "six.test", { all })).err?.code).toBe(
        REFUSED_TARGET_CODE,
      );
    }
    expect((await run(hook, "public.test")).result).toEqual(PUB);
    expect((await run(hook, "public.test", { all: true })).result).toEqual([
      PUB,
    ]);
  });

  it("never lets an ordinary name resolve to loopback, even with allowLoopback", async () => {
    const { lookup } = fakeLookup({
      "evil.example": [LOOP],
      localhost: [LOOP],
      "web.localhost": [LOOP],
      "liar.localhost": [PUB],
    });
    const strict = guardedLookup({ lookup });
    const loop = guardedLookup({ lookup, allowLoopback: true });
    expect((await run(loop, "evil.example")).err?.code).toBe(
      REFUSED_TARGET_CODE,
    );
    expect((await run(strict, "evil.example")).err?.code).toBe(
      REFUSED_TARGET_CODE,
    );
    expect((await run(strict, "localhost")).err?.code).toBe(
      REFUSED_TARGET_CODE,
    );
    expect((await run(loop, "localhost")).result).toEqual(LOOP);
    expect((await run(loop, "web.localhost")).result).toEqual(LOOP);
    // a localhost name must actually resolve to loopback
    expect((await run(loop, "liar.localhost")).err?.code).toBe(
      REFUSED_TARGET_CODE,
    );
  });

  it("refuses refused names without resolving them", async () => {
    const { lookup, calls } = fakeLookup({ "metadata.google.internal": [PUB] });
    const hook = guardedLookup({ lookup, allowLoopback: true });
    expect((await run(hook, "metadata.google.internal")).err?.code).toBe(
      REFUSED_TARGET_CODE,
    );
    expect((await run(hook, "")).err?.code).toBe(REFUSED_TARGET_CODE);
    expect(calls).toEqual([]);
  });

  it("refuses an empty answer", async () => {
    const { lookup } = fakeLookup({ "empty.test": [] });
    for (const all of [false, true]) {
      const r = await run(guardedLookup({ lookup }), "empty.test", { all });
      expect(r.err?.code).toBe(REFUSED_TARGET_CODE);
    }
  });

  it("passes resolver errors through", async () => {
    const { lookup } = fakeLookup({});
    const r = await run(guardedLookup({ lookup }), "nowhere.test");
    expect(r.err?.code).toBe("ENOTFOUND");
  });
});

describe("project host agents, real connections", () => {
  let server: http.Server;
  let port: number;
  let connections = 0;
  let proxy: http.Server;
  let proxyPort: number;
  let proxyConnections = 0;
  const saved = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
    NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY,
  };

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end("target"));
    server.on("connection", () => (connections += 1));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    proxy = http.createServer((_req, res) => res.end("proxy"));
    proxy.on("connection", () => (proxyConnections += 1));
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise((r) => server.close(r));
    await new Promise((r) => proxy.close(r));
  });

  beforeEach(() => {
    connections = 0;
    proxyConnections = 0;
  });

  function get(
    url: string,
    agent: http.Agent,
    extra: any = {},
  ): Promise<{ err?: any; body?: string }> {
    return new Promise((resolve) => {
      const req = http.get(url, { agent, ...extra }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ body }));
      });
      req.on("error", (err) => resolve({ err }));
    });
  }

  it("refuses a name that resolves to loopback, and the target never sees a connection", async () => {
    const { lookup } = fakeLookup({ "evil.example": [LOOP] });
    for (const allowLoopback of [false, true]) {
      const agent = createProjectHostAgent({
        secure: false,
        allowLoopback,
        lookup,
      });
      const r = await get(`http://evil.example:${port}/`, agent);
      expect(r.err?.code).toBe(REFUSED_TARGET_CODE);
    }
    expect(connections).toBe(0);
  });

  it("connects a localhost name with allowLoopback (the positive control)", async () => {
    const { lookup, calls } = fakeLookup({ localhost: [LOOP] });
    const agent = createProjectHostAgent({
      secure: false,
      allowLoopback: true,
      lookup,
    });
    const r = await get(`http://localhost:${port}/`, agent);
    expect(r.body).toBe("target");
    expect(connections).toBe(1);
    expect(calls).toEqual(["localhost"]);
  });

  it("pins the checked address: one lookup per connection, never a second answer", async () => {
    let n = 0;
    // first answer is allowed, any later one would be a rebinding to metadata
    const lookup: any = (_h: string, options: any, cb: any) => {
      n += 1;
      const answers = n === 1 ? [LOOP] : [META];
      if (options?.all) process.nextTick(cb, null, answers);
      else process.nextTick(cb, null, answers[0].address, answers[0].family);
    };
    const agent = createProjectHostAgent({
      secure: false,
      allowLoopback: true,
      lookup,
    });
    const r = await get(`http://localhost:${port}/`, agent);
    expect(r.body).toBe("target");
    expect(n).toBe(1);
    expect(connections).toBe(1);
  });

  it("every new socket goes through the hook (no kept-alive socket skips it)", async () => {
    const { lookup, calls } = fakeLookup({ localhost: [LOOP] });
    const agent = createProjectHostAgent({
      secure: false,
      allowLoopback: true,
      lookup,
    });
    expect((agent as any).keepAlive).toBe(false);
    await get(`http://localhost:${port}/a`, agent);
    await get(`http://localhost:${port}/b`, agent);
    expect(calls).toEqual(["localhost", "localhost"]);
  });

  it("checks literal addresses: loopback only with allowLoopback, link-local never", async () => {
    const strict = createProjectHostAgent({ secure: false });
    expect((await get(`http://127.0.0.1:${port}/`, strict)).err?.code).toBe(
      REFUSED_TARGET_CODE,
    );
    expect((await get(`http://[::1]:${port}/`, strict)).err?.code).toBe(
      REFUSED_TARGET_CODE,
    );
    const loop = createProjectHostAgent({ secure: false, allowLoopback: true });
    expect((await get(`http://169.254.169.254:${port}/`, loop)).err?.code).toBe(
      REFUSED_TARGET_CODE,
    );
    expect((await get(`http://0.0.0.0:${port}/`, loop)).err?.code).toBe(
      REFUSED_TARGET_CODE,
    );
    expect(connections).toBe(0);
    expect((await get(`http://127.0.0.1:${port}/`, loop)).body).toBe("target");
    expect(connections).toBe(1);
  });

  it("ignores HTTP(S)_PROXY: a refused target reaches neither, an allowed one goes direct", async () => {
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    process.env.http_proxy = `http://127.0.0.1:${proxyPort}`;
    process.env.NODE_USE_ENV_PROXY = "1";
    const { lookup } = fakeLookup({
      "evil.example": [LOOP],
      localhost: [LOOP],
    });
    const agent = createProjectHostAgent({
      secure: false,
      allowLoopback: true,
      lookup,
    });
    expect((await get(`http://evil.example:${port}/`, agent)).err?.code).toBe(
      REFUSED_TARGET_CODE,
    );
    expect((await get(`http://localhost:${port}/`, agent)).body).toBe("target");
    expect(proxyConnections).toBe(0);
    expect(connections).toBe(1);
  });

  it("refuses a unix socket path", async () => {
    const agent = createProjectHostAgent({
      secure: false,
      allowLoopback: true,
    });
    const r = await get("http://localhost/", agent, {
      socketPath: "/tmp/never.sock",
    });
    expect(r.err?.code).toBe(REFUSED_TARGET_CODE);
  });

  it("the https agent refuses the same way, before any TLS", async () => {
    const https = await import("node:https");
    const { lookup } = fakeLookup({ "evil.example": [LOOP] });
    const agent = createProjectHostAgent({
      secure: true,
      allowLoopback: true,
      lookup,
    });
    const err: any = await new Promise((resolve) => {
      const req = https.get(`https://evil.example:${port}/`, { agent }, () =>
        resolve(undefined),
      );
      req.on("error", resolve);
    });
    expect(err?.code).toBe(REFUSED_TARGET_CODE);
    expect(connections).toBe(0);
  });
});

describe("agent selection", () => {
  const saved = process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
  afterEach(() => {
    if (saved == null)
      delete process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
    else process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = saved;
  });

  it("isBayTunnelAddress accepts only the bay's own tunnel form", () => {
    expect(isBayTunnelAddress("http://127.0.0.1:43211")).toBe(true);
    expect(isBayTunnelAddress("http://127.0.0.1:43211/")).toBe(true);
    for (const bad of [
      "https://127.0.0.1:43211",
      "http://127.0.0.2:43211",
      "http://localhost:43211",
      "http://127.0.0.1:22",
      "http://127.0.0.1",
      "http://127.0.0.1:43211/x",
      "http://127.0.0.1:43211/?a=1",
      "http://u@127.0.0.1:43211",
      "not a url",
    ]) {
      expect(isBayTunnelAddress(bad)).toBe(false);
    }
  });

  it("projectHostAgentFor picks http/https and allows loopback only where it may", () => {
    delete process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
    const strictHttp = projectHostAgentFor("http://host.example.com");
    const strictHttps = projectHostAgentFor("https://host.example.com");
    const tunnel = projectHostAgentFor("http://127.0.0.1:43211");
    expect(strictHttps).not.toBe(strictHttp);
    expect(tunnel).not.toBe(strictHttp);
    expect(projectHostAgentFor("wss://host.example.com")).toBe(strictHttps);
    expect(projectHostAgentFor("http://other.example.com")).toBe(strictHttp);
    expect(
      projectHostAgentFor("http://x.example", { allowLoopback: true }),
    ).toBe(tunnel);
    process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = "1";
    expect(projectHostAgentFor("http://host.example.com")).toBe(tunnel);
  });
});
