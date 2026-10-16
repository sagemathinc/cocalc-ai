/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The connector's dealings with the site, which it doesn't trust: pairing
// lines, answers it parses, and how it reads "revoked".

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pairComputer,
  parsePairingUrl,
  post,
  RevokedError,
  runConnector,
  TransientError,
} from "./connector";

let server: Server;
let origin: string;
let handler: (path: string, body: any) => { status?: number; json: any };
let xdg: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      const path = (req.url ?? "").replace("/api/v2/computers/", "");
      const { status = 200, json } = handler(path, JSON.parse(data || "{}"));
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  xdg = mkdtempSync(join(tmpdir(), "computers-xdg-"));
  process.env.XDG_DATA_HOME = xdg;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(xdg, { recursive: true, force: true });
  delete process.env.XDG_DATA_HOME;
});

const io = () => {
  const logs: string[] = [];
  return { logs, log: (m: string) => logs.push(m), confirm: async () => true };
};

test("a pairing line is the site's origin and a request id; https except locally", () => {
  expect(parsePairingUrl("https://cocalc.ai/c/R-0123456789")).toEqual({
    origin: "https://cocalc.ai",
    request_id: "R-0123456789",
  });
  expect(() => parsePairingUrl("http://evil.example/c/R-0123456789")).toThrow(
    "https",
  );
  expect(() => parsePairingUrl("https://cocalc.ai/c/nope")).toThrow();
});

test("the site's errors: revoked ends it, transient waits, others fail", async () => {
  handler = () => ({
    json: { error: "this computer was revoked", revoked: true },
  });
  await expect(post(origin, "connect", {})).rejects.toBeInstanceOf(
    RevokedError,
  );
  handler = () => ({
    json: { error: "its project has no host yet", transient: true },
  });
  await expect(post(origin, "connect", {})).rejects.toBeInstanceOf(
    TransientError,
  );
  handler = () => ({ status: 502, json: {} });
  await expect(post(origin, "connect", {})).rejects.toBeInstanceOf(
    TransientError,
  );
  handler = () => ({ json: { error: "no such computer\u001b[31m" } });
  await expect(post(origin, "connect", {})).rejects.toThrow(
    "no such computer?[31m",
  );
});

test("pairing: claim, show the phrase, wait for approval, keep the token privately", async () => {
  const secret = "s".repeat(43);
  const computer_id = "00000000-0000-4000-8000-000000000005";
  const project_id = "00000000-0000-4000-8000-000000000006";
  let polls = 0;
  handler = (path, body) => {
    if (path === "pairing/view") {
      return {
        json: {
          request_id: body.request_id,
          name: "m1",
          account_label: "Ada",
          state: "pending",
        },
      };
    }
    if (path === "pairing/claim") {
      expect(body.machine).toMatchObject({ os: process.platform });
      return {
        json: {
          request_id: body.request_id,
          name: "m1",
          account_label: "Ada",
          pairing_phrase: "acorn-amber-anchor-apple",
          expires_at: Date.now() + 60_000,
          secret,
        },
      };
    }
    expect(path).toBe("pairing/status");
    expect(body.secret).toBe(secret);
    polls += 1;
    return {
      json:
        polls < 2
          ? { state: "claimed" }
          : { state: "approved", computer_id, project_id },
    };
  };
  const out = io();
  const connection = await pairComputer({
    url: `${origin}/c/R-0123456789`,
    io: out,
    pollMs: 10,
  });
  expect(connection).toMatchObject({
    computer_id,
    project_id,
    name: "m1",
    token: secret,
  });
  expect(out.logs.join("\n")).toContain("acorn-amber-anchor-apple");
  expect(statSync(join(connection.dir, "connection.json")).mode & 0o077).toBe(
    0,
  );
});

test("asked for a host token, the site says revoked: the connector ends", async () => {
  handler = () => ({
    json: { error: "this computer was revoked", revoked: true },
  });
  const out = io();
  await runConnector({
    connection: {
      dir: xdg,
      origin,
      computer_id: "00000000-0000-4000-8000-000000000007",
      name: "m2",
      project_id: "00000000-0000-4000-8000-000000000006",
      token: "t".repeat(43),
    },
    io: out,
  });
  expect(out.logs.join("\n")).toMatch(/revoked/);
});
