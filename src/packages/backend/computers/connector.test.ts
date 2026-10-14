/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The machine's pairing client against a pairing server that may lie: it
// must take identities only from the signed certificate and its own
// resolved policy, never from unsigned duplicate fields.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseComputerCertificate,
  SIGNED_KINDS,
} from "@cocalc/util/computers/protocol";
import { parseComputerPolicy } from "@cocalc/util/computers/policy";
import {
  generateSigningKey,
  policyHash,
  randomNonce,
  signEnvelope,
  transcriptHash,
} from "./crypto";
import { pairComputer, parsePairingUrl } from "./connector";
import { DaemonStore } from "./daemon/state";

const SITE = "https://cocalc.example";
const REQUEST = "R-ABCDEFGHJK";

describe("pairing as the machine", () => {
  let dataHome: string;
  const realFetch = global.fetch;
  const network = randomUUID();
  const account = randomUUID();
  const bayKey = generateSigningKey();
  const requested = {
    version: 1,
    mode: "direct",
    duration: null,
    agent_network_id: network,
    network: "on",
    gpu: true,
    mounts: [],
    images: { kind: "any" },
    scratch_bytes: null,
    limits: { cpu_millis: null, memory_bytes: null, pids: null },
  };

  beforeEach(() => {
    dataHome = mkdtempSync(join(tmpdir(), "xdg-"));
    process.env.XDG_DATA_HOME = dataHome;
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.XDG_DATA_HOME;
    rmSync(dataHome, { recursive: true, force: true });
  });

  /**
   * A fake site. `approve` builds the approved status from the transcript
   * the machine submitted (and may lie).
   */
  function site(approve: (submitted: any) => any) {
    let submitted: any;
    global.fetch = (async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      const path = new URL(url).pathname;
      let answer: any;
      if (path.endsWith("/pairing/view")) {
        answer = {
          site: SITE,
          cluster_id: "c1",
          request_id: body.request_id,
          account_id: account,
          account_label: "Ada \u202eLovelace\u0007",
          name: "m1",
          requested_policy: requested,
          why: "tests",
          server_nonce: randomNonce(),
          state: "pending",
          expires_at: Date.now() + 60_000,
        };
      } else if (path.endsWith("/pairing/submit")) {
        submitted = body;
        answer = {
          pairing_phrase: "whatever the server says",
          transcript_hash: transcriptHash(body.transcript.payload),
        };
      } else if (path.endsWith("/pairing/status")) {
        answer = approve(submitted);
        if (answer instanceof Response) return answer;
      }
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as any;
  }

  function certificateFor(submitted: any, overrides: object = {}) {
    const t = submitted.transcript.payload;
    return signEnvelope(
      SIGNED_KINDS.certificate,
      parseComputerCertificate({
        type: "cocalc-computer-certificate",
        version: 1,
        site: SITE,
        cluster_id: "c1",
        computer_id: randomUUID(),
        account_id: account,
        home_bay_id: "bay-0",
        home_epoch: 0,
        signing_key: t.signing_key,
        signing_public_key: submitted.signing_public_key,
        agreement_key: t.agreement_key,
        transcript_hash: transcriptHash(t),
        ceiling_hash: policyHash(parseComputerPolicy(requested)),
        not_before: Date.now(),
        not_after: Date.now() + 3_600_000,
        ...overrides,
      }),
      bayKey,
    );
  }

  const directory = () => [
    {
      kid: bayKey.fingerprint,
      bay_id: "bay-0",
      public_key: bayKey.publicDer,
      not_after: Date.now() + 3_600_000,
    },
  ];

  const logs: string[] = [];
  const io = (answer = true) => ({
    log: (m: string) => logs.push(m),
    confirm: async () => answer,
  });

  it("parses only real pairing lines", () => {
    expect(parsePairingUrl(`${SITE}/c/${REQUEST}`)).toEqual({
      origin: SITE,
      request_id: REQUEST,
    });
    for (const bad of [
      `http://evil.example/c/${REQUEST}`,
      `${SITE}/c/R-../../etc`,
      `${SITE}/x/${REQUEST}`,
      "not a url",
    ]) {
      expect(() => parsePairingUrl(bad)).toThrow();
    }
  });

  it("nothing is claimed if the person at the machine says no", async () => {
    let claimed = false;
    site(() => {
      claimed = true;
    });
    await expect(
      pairComputer({ url: `${SITE}/c/${REQUEST}`, io: io(false) }),
    ).rejects.toThrow(/not connected/);
    expect(claimed).toBe(false);
  });

  it("takes the computer id, network and paths from the signed certificate and its own policy, never from unsigned fields", async () => {
    let certificate: any;
    site((submitted) => {
      certificate = certificateFor(submitted);
      return {
        state: "approved",
        certificate,
        directory: directory(),
        // Lies the machine must ignore.
        computer_id: "../../../../tmp/evil",
        agent_network_id: randomUUID(),
        policy: { ...requested, agent_network_id: randomUUID() },
        // A valid but different name: still ignored (it is unsigned).
        name: "other-name",
      };
    });
    logs.length = 0;
    const c = await pairComputer({
      url: `${SITE}/c/${REQUEST}`,
      io: io(),
      pollMs: 1,
    });
    expect(c.computer_id).toBe(certificate.payload.computer_id);
    expect(c.name).toBe("m1");
    expect(readdirSync(join(dataHome, "cocalc", "computers"))).toEqual([
      c.computer_id,
    ]);
    const store = DaemonStore.open(join(c.dir, "state"))!;
    expect(store.state.agent_network_id).toBe(network);
    // Shown text is cleaned of control and bidi characters.
    expect(logs.join("\n")).not.toMatch(/[\u202e\u0007]/);
    // The phrase is computed locally, not taken from the server.
    expect(logs.join("\n")).not.toMatch(/whatever the server says/);
    expect(existsSync(join(c.dir, "key.pem"))).toBe(true);
    expect(existsSync(join(c.dir, "agreement.pem"))).toBe(true);
  });

  it("keeps waiting for approval while the site restarts (5xx, unreachable)", async () => {
    let calls = 0;
    site((submitted) => {
      calls += 1;
      if (calls === 1) return { state: "paired" };
      if (calls === 2)
        return new Response("<html>Bad Gateway</html>", { status: 502 });
      if (calls === 3) throw new TypeError("fetch failed");
      if (calls === 4) return new Response("{}", { status: 503 });
      return {
        state: "approved",
        certificate: certificateFor(submitted),
        directory: directory(),
      };
    });
    logs.length = 0;
    const c = await pairComputer({
      url: `${SITE}/c/${REQUEST}`,
      io: io(),
      pollMs: 1,
    });
    expect(c.name).toBe("m1");
    expect(calls).toBe(5);
    const shown = logs.join("\n");
    // Said once per outage, and once when it is back.
    expect(shown.match(/still waiting/g)).toHaveLength(1);
    expect(shown).toMatch(/Reached it again/);
  });

  it("keeps waiting when the connection drops while the answer is being read", async () => {
    let calls = 0;
    site((submitted) => {
      calls += 1;
      if (calls === 1) {
        // Headers and part of the JSON arrive, then the hub goes away.
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"sta'));
            c.error(new TypeError("terminated: other side closed"));
          },
        });
        return new Response(body, { status: 200 });
      }
      return {
        state: "approved",
        certificate: certificateFor(submitted),
        directory: directory(),
      };
    });
    logs.length = 0;
    const c = await pairComputer({
      url: `${SITE}/c/${REQUEST}`,
      io: io(),
      pollMs: 1,
    });
    expect(c.name).toBe("m1");
    expect(logs.join("\n")).toMatch(/still waiting/);
  });

  it("stopping while it waits out an outage is immediate", async () => {
    site(() => new Response("bad gateway", { status: 502 }));
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    await expect(
      pairComputer({
        url: `${SITE}/c/${REQUEST}`,
        io: io(),
        // The backoff after the first 502 is 20 s.
        pollMs: 10_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/stopped/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a real refusal while waiting still ends it at once", async () => {
    site(
      () =>
        new Response(JSON.stringify({ error: "no such request" }), {
          status: 404,
        }),
    );
    await expect(
      pairComputer({ url: `${SITE}/c/${REQUEST}`, io: io(), pollMs: 1 }),
    ).rejects.toThrow(/no such request/);
  });

  it("refuses a certificate for another key, account, transcript or policy", async () => {
    for (const lie of [
      (s: any) => ({ signing_key: generateSigningKey().fingerprint }),
      () => ({ account_id: randomUUID() }),
      () => ({ transcript_hash: `sha256:${"A".repeat(43)}` }),
      () => ({ ceiling_hash: `sha256:${"B".repeat(43)}` }),
    ]) {
      site((submitted) => ({
        state: "approved",
        certificate: certificateFor(submitted, lie(submitted)),
        directory: directory(),
      }));
      await expect(
        pairComputer({ url: `${SITE}/c/${REQUEST}`, io: io(), pollMs: 1 }),
      ).rejects.toThrow(/not for this pairing/);
    }
    expect(existsSync(join(dataHome, "cocalc", "computers"))).toBe(false);
  });

  it("refuses a certificate not signed by a key the directory gives for its home bay", async () => {
    site((submitted) => ({
      state: "approved",
      certificate: certificateFor(submitted),
      directory: [{ ...directory()[0], bay_id: "another-bay" }],
    }));
    await expect(
      pairComputer({ url: `${SITE}/c/${REQUEST}`, io: io(), pollMs: 1 }),
    ).rejects.toThrow(/not signed by the computer's home bay/);
  });

  it("refuses to overwrite a computer already paired here", async () => {
    let certificate: any;
    site((submitted) => {
      certificate ??= certificateFor(submitted);
      mkdirSync(
        join(dataHome, "cocalc", "computers", certificate.payload.computer_id),
        { recursive: true },
      );
      return { state: "approved", certificate, directory: directory() };
    });
    await expect(
      pairComputer({ url: `${SITE}/c/${REQUEST}`, io: io(), pollMs: 1 }),
    ).rejects.toThrow(/already paired here/);
  });
});

describe("the pairing HTTP boundary, before anyone has confirmed anything", () => {
  let server: Server;
  let port: number;
  let other: Server;
  let otherHits = 0;
  let handler: (req, res) => void = () => {};

  beforeAll(async () => {
    server = createServer((req, res) => handler(req, res));
    other = createServer((_req, res) => {
      otherHits += 1;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    port = (server.address() as any).port;
  });
  afterAll(async () => {
    server.closeAllConnections?.();
    other.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await new Promise((r) => other.close(r));
  });

  const url = () => `http://127.0.0.1:${port}/c/${REQUEST}`;
  const io = { log: () => {}, confirm: async () => true };

  it("never follows a redirect (e.g. to a local service)", async () => {
    const target = `http://127.0.0.1:${(other.address() as any).port}/x`;
    handler = (_req, res) => {
      res.writeHead(307, { location: target });
      res.end();
    };
    await expect(pairComputer({ url: url(), io })).rejects.toThrow(
      /could not reach/,
    );
    expect(otherHits).toBe(0);
  });

  it("refuses an oversized answer without reading it all", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"x":"');
      const chunk = "x".repeat(64 * 1024);
      const timer = setInterval(() => {
        if (!res.write(chunk)) return;
      }, 1);
      res.on("close", () => clearInterval(timer));
    };
    await expect(pairComputer({ url: url(), io })).rejects.toThrow(/too large/);
  });

  it("an endless answer is stopped by the caller", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{"); // and nothing more, ever
    };
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const start = Date.now();
    await expect(
      pairComputer({ url: url(), io, signal: stop.signal }),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("cleans error text from the server before it is shown", async () => {
    handler = (_req, res) => {
      res.end(JSON.stringify({ error: "bad \u001b[31mred\u202e evil" }));
    };
    const err: Error = await pairComputer({ url: url(), io }).catch((e) => e);
    expect(err.message).not.toMatch(/[\u001b\u202e]/);
    expect(err.message).toMatch(/bad/);
  });

  it("refuses a view whose site is not the origin it was fetched from", async () => {
    handler = (req, res) => {
      res.end(
        JSON.stringify({
          site: "https://cocalc.example",
          cluster_id: "c1",
          request_id: REQUEST,
          account_id: randomUUID(),
          account_label: "x",
          name: "m1",
          requested_policy: {},
          why: "",
          server_nonce: randomNonce(),
          state: "pending",
        }),
      );
    };
    await expect(pairComputer({ url: url(), io })).rejects.toThrow(
      /is for https:\/\/cocalc.example, not http:\/\/127.0.0.1/,
    );
  });
});
