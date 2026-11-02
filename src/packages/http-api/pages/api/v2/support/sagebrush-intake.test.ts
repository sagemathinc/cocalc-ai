/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { PassThrough } from "stream";
import { createResponse } from "node-mocks-http";

const mockCreateTicket = jest.fn();
const mockNormalize = jest.fn();
const mockGetServerSettings = jest.fn();
const logLines: string[] = [];

class MockRateLimitError extends Error {
  code = "support_ticket_rate_limited";
}

jest.mock("@cocalc/server/support/create-ticket", () => ({
  __esModule: true,
  default: (...args) => mockCreateTicket(...args),
  normalizeSupportTicketOptions: (...args) => mockNormalize(...args),
}));

jest.mock("@cocalc/server/support/rate-limit", () => ({
  __esModule: true,
  SupportTicketRateLimitError: MockRateLimitError,
}));

jest.mock("@cocalc/database/settings", () => ({
  __esModule: true,
  getServerSettings: (...args) => mockGetServerSettings(...args),
}));

jest.mock("@cocalc/backend/logger", () => {
  const capture =
    (level: string) =>
    (...args: unknown[]) =>
      logLines.push(`${level} ${JSON.stringify(args)}`);
  return {
    __esModule: true,
    getLogger: () => ({
      debug: capture("debug"),
      info: capture("info"),
      warn: capture("warn"),
      error: capture("error"),
    }),
  };
});

import handler, {
  composeBody,
  composeSubject,
  KINDS,
  parseIntakeKeys,
} from "./sagebrush-intake";

const KEY_A = "A".repeat(42) + "a";
const KEY_B = "b".repeat(42) + "_";
const IP = "203.0.113.7";
const SUBMISSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const DEFAULT_EMAIL = "no-reply@sagebrush.example";

function validBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    submission_id: SUBMISSION,
    kind: "pkg",
    title: "Please add polars",
    description: "import polars fails with ModuleNotFoundError.",
    email: "reader@example.com",
    ...extra,
  });
}

// A real stream with the headers a Node HTTP server would give the handler.
function makeReq({
  body = validBody(),
  method = "POST",
  headers,
  contentLength,
}: {
  body?: string | Buffer;
  method?: string;
  headers?: [string, string][];
  contentLength?: string | null;
} = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const raw: [string, string][] = headers ?? [
    ["Content-Type", "application/json"],
    ["X-Sagebrush-Intake-Key", KEY_A],
    ["X-Sagebrush-Client-IP", IP],
  ];
  if (contentLength !== null) {
    raw.push(["Content-Length", contentLength ?? `${bytes.length}`]);
  }
  const req: any = new PassThrough();
  req.method = method;
  req.rawHeaders = raw.flat();
  req.headers = {};
  for (const [name, value] of raw) req.headers[name.toLowerCase()] = value;
  req.end(bytes);
  return req;
}

async function run(req: any) {
  const res = createResponse();
  await handler(req, res as any);
  return {
    status: res._getStatusCode(),
    body: res._getJSONData(),
    cache: res.getHeader("Cache-Control"),
  };
}

function headersWith(
  overrides: Record<string, string | string[] | null>,
): [string, string][] {
  const base: Record<string, string | string[] | null> = {
    "Content-Type": "application/json",
    "X-Sagebrush-Intake-Key": KEY_A,
    "X-Sagebrush-Client-IP": IP,
    ...overrides,
  };
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(base)) {
    if (value == null) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.push([name, v]);
  }
  return out;
}

beforeEach(() => {
  logLines.length = 0;
  mockCreateTicket
    .mockReset()
    .mockResolvedValue("https://support.example/requests/1");
  mockNormalize.mockReset().mockImplementation((x) => x);
  mockGetServerSettings.mockReset().mockResolvedValue({
    sagebrush_support_intake_key: KEY_A,
    sagebrush_support_default_email: DEFAULT_EMAIL,
  });
});

describe("a valid request", () => {
  it("creates one ticket in the intake namespace and answers only {ok: true}", async () => {
    const r = await run(makeReq());
    expect(r).toEqual({ status: 200, body: { ok: true }, cache: "no-store" });
    expect(mockCreateTicket).toHaveBeenCalledTimes(1);
    const [options, internal] = mockCreateTicket.mock.calls[0];
    expect(options).toEqual({
      email: "reader@example.com",
      subject: "[sagebrush] pkg: Please add polars",
      body: expect.stringContaining(
        "import polars fails with ModuleNotFoundError.",
      ),
      ip_address: IP,
    });
    expect(options.body).toContain(`submission: ${SUBMISSION}`);
    expect(options).not.toHaveProperty("account_id");
    expect(options).not.toHaveProperty("files");
    expect(options).not.toHaveProperty("support_content_consent");
    expect(internal).toEqual({
      source: "sagebrush-intake",
      skip_email_rules: false,
      extra_tags: ["sagebrush", "sb-kind-pkg"],
    });
    // normalized (validated) before createTicket charges the quota
    expect(mockNormalize.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateTicket.mock.invocationCallOrder[0],
    );
  });

  it("never forwards the ticket URL", async () => {
    const r = await run(makeReq());
    expect(JSON.stringify(r.body)).not.toContain("support.example");
  });

  it("accepts the previous key while rotating", async () => {
    mockGetServerSettings.mockResolvedValue({
      sagebrush_support_intake_key: `${KEY_B},${KEY_A}`,
      sagebrush_support_default_email: DEFAULT_EMAIL,
    });
    expect((await run(makeReq())).status).toBe(200);
    const b = makeReq({
      headers: headersWith({ "X-Sagebrush-Intake-Key": KEY_B }),
    });
    expect((await run(b)).status).toBe(200);
  });
});

describe("the email policy", () => {
  it("an omitted email uses the default, skips the email rules and tags sb-no-email", async () => {
    const body = JSON.stringify({
      submission_id: SUBMISSION,
      kind: "bug",
      title: "Plot is blank",
      description: "plt.show() renders nothing in the notebook.",
    });
    expect((await run(makeReq({ body }))).status).toBe(200);
    const [options, internal] = mockCreateTicket.mock.calls[0];
    expect(options.email).toBe(DEFAULT_EMAIL);
    expect(internal).toEqual({
      source: "sagebrush-intake",
      skip_email_rules: true,
      extra_tags: ["sagebrush", "sb-kind-bug", "sb-no-email"],
    });
  });

  it("a typed default address keeps the email rules", async () => {
    const r = await run(makeReq({ body: validBody({ email: DEFAULT_EMAIL }) }));
    expect(r.status).toBe(200);
    const [options, internal] = mockCreateTicket.mock.calls[0];
    expect(options.email).toBe(DEFAULT_EMAIL);
    expect(internal.skip_email_rules).toBe(false);
    expect(internal.extra_tags).not.toContain("sb-no-email");
  });

  it("an omitted email without a configured default is a 400", async () => {
    mockGetServerSettings.mockResolvedValue({
      sagebrush_support_intake_key: KEY_A,
      sagebrush_support_default_email: "",
    });
    const body = JSON.stringify({
      submission_id: SUBMISSION,
      kind: "bug",
      title: "Plot is blank",
      description: "plt.show() renders nothing in the notebook.",
    });
    const r = await run(makeReq({ body }));
    expect(r).toEqual({
      status: 400,
      body: { error: "email-required" },
      cache: "no-store",
    });
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it("an email createTicket would refuse is a 400 before any charge", async () => {
    mockNormalize.mockImplementation(() => {
      throw Error("support ticket email must be valid");
    });
    const r = await run(
      makeReq({ body: validBody({ email: "not-an-email" }) }),
    );
    expect(r.status).toBe(400);
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });
});

describe("headers, before any body byte is read", () => {
  it.each([
    ["GET", 405],
    ["PUT", 405],
  ])("method %s gives %d", async (method, status) => {
    const r = await run(makeReq({ method }));
    expect(r.status).toBe(status);
    expect(r.cache).toBe("no-store");
    expect(mockGetServerSettings).not.toHaveBeenCalled();
  });

  it("refuses an Authorization header", async () => {
    const req = makeReq({
      headers: headersWith({ Authorization: "Bearer cocalc_api_key_test" }),
    });
    expect((await run(req)).status).toBe(400);
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it.each([
    ["text/plain", 415],
    ["application/x-www-form-urlencoded", 415],
  ])("Content-Type %s gives %d", async (type, status) => {
    const req = makeReq({ headers: headersWith({ "Content-Type": type }) });
    expect((await run(req)).status).toBe(status);
  });

  it("a missing Content-Type gives 415", async () => {
    const req = makeReq({ headers: headersWith({ "Content-Type": null }) });
    expect((await run(req)).status).toBe(415);
  });

  it("a missing Content-Length gives 411", async () => {
    expect((await run(makeReq({ contentLength: null }))).status).toBe(411);
  });

  it("a chunked body gives 411", async () => {
    const req = makeReq({
      contentLength: null,
      headers: headersWith({ "Transfer-Encoding": "chunked" }),
    });
    expect((await run(req)).status).toBe(411);
  });

  it("a Content-Length over 131072 gives 413 without reading the key", async () => {
    const r = await run(makeReq({ contentLength: "131073" }));
    expect(r.status).toBe(413);
    expect(mockGetServerSettings).not.toHaveBeenCalled();
  });

  it("a malformed Content-Length gives 400", async () => {
    expect((await run(makeReq({ contentLength: "12, 12" }))).status).toBe(400);
  });
});

describe("the key setting grammar", () => {
  it.each([
    ["blank", ""],
    ["a trailing comma", `${KEY_A},`],
    ["an empty component", `,${KEY_A}`],
    ["three keys", `${KEY_A},${KEY_B},${"c".repeat(43)}`],
    ["a duplicate", `${KEY_A},${KEY_A}`],
    ["a short key", "A".repeat(42)],
    ["a long key", "A".repeat(44)],
    ["a bad character", "A".repeat(42) + "="],
    ["a space", `${KEY_A}, ${KEY_B}`],
    ["not a string", 123],
  ])("%s disables the route", async (_label, value) => {
    expect(parseIntakeKeys(value)).toBeUndefined();
    mockGetServerSettings.mockResolvedValue({
      sagebrush_support_intake_key: value,
      sagebrush_support_default_email: DEFAULT_EMAIL,
    });
    const r = await run(makeReq());
    expect(r).toEqual({
      status: 503,
      body: { error: "unavailable" },
      cache: "no-store",
    });
    expect(logLines.join("\n")).toContain("intake-key-config-invalid");
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it("one key and two different keys are valid", () => {
    expect(parseIntakeKeys(KEY_A)).toHaveLength(1);
    expect(parseIntakeKeys(`${KEY_A},${KEY_B}`)).toHaveLength(2);
  });

  it("an unreadable settings table gives 503", async () => {
    mockGetServerSettings.mockRejectedValue(Error("db down"));
    expect((await run(makeReq())).status).toBe(503);
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });
});

describe("the key header", () => {
  it.each([
    ["a wrong key", { "X-Sagebrush-Intake-Key": KEY_B }],
    ["an over-long key", { "X-Sagebrush-Intake-Key": KEY_A + "x".repeat(30) }],
    ["a duplicate header", { "X-Sagebrush-Intake-Key": [KEY_A, KEY_A] }],
    ["a missing header", { "X-Sagebrush-Intake-Key": null }],
    ["a key with a prefix", { "X-Sagebrush-Intake-Key": `Bearer ${KEY_A}` }],
  ])("%s gives 401", async (_label, overrides) => {
    const r = await run(makeReq({ headers: headersWith(overrides as any) }));
    expect(r).toEqual({
      status: 401,
      body: { error: "unauthorized" },
      cache: "no-store",
    });
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it("a bad key with a spoofed valid IP gives 401 and never reads the IP header", async () => {
    const req = makeReq({
      headers: headersWith({ "X-Sagebrush-Intake-Key": KEY_B }),
    });
    const seen: string[] = [];
    const raw: string[] = req.rawHeaders;
    req.rawHeaders = new Proxy(raw, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (
          typeof prop === "string" &&
          /^[0-9]+$/.test(prop) &&
          Number(prop) % 2 === 1 &&
          `${target[Number(prop) - 1]}`.toLowerCase() ===
            "x-sagebrush-client-ip"
        ) {
          seen.push(value);
        }
        return value;
      },
    });
    expect((await run(req)).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("no key value appears in any log line", async () => {
    await run(
      makeReq({ headers: headersWith({ "X-Sagebrush-Intake-Key": KEY_B }) }),
    );
    mockGetServerSettings.mockResolvedValue({
      sagebrush_support_intake_key: `${KEY_A},`,
    });
    await run(makeReq());
    mockGetServerSettings.mockResolvedValue({
      sagebrush_support_intake_key: KEY_A,
      sagebrush_support_default_email: DEFAULT_EMAIL,
    });
    mockCreateTicket.mockRejectedValue(Error(`zendesk said ${KEY_A}`));
    await run(makeReq());
    const all = logLines.join("\n");
    expect(logLines.length).toBeGreaterThan(0);
    expect(all).not.toContain(KEY_A);
    expect(all).not.toContain(KEY_B);
  });
});

describe("the client IP header", () => {
  it.each([
    ["missing", { "X-Sagebrush-Client-IP": null }],
    ["malformed", { "X-Sagebrush-Client-IP": "203.0.113" }],
    ["a hostname", { "X-Sagebrush-Client-IP": "example.com" }],
    ["a list", { "X-Sagebrush-Client-IP": "203.0.113.7, 198.51.100.1" }],
    ["duplicate", { "X-Sagebrush-Client-IP": [IP, IP] }],
    ["over-long", { "X-Sagebrush-Client-IP": "1".repeat(46) }],
  ])("%s gives 400 with no attempt", async (_label, overrides) => {
    const r = await run(makeReq({ headers: headersWith(overrides as any) }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "bad-client-ip" });
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it("accepts IPv6 and never uses forwarded headers, req.ip or cookies", async () => {
    const req = makeReq({
      headers: headersWith({
        "X-Sagebrush-Client-IP": "2001:db8::7",
        "X-Forwarded-For": "198.51.100.1",
        Cookie:
          "remember_me=abc; account_id=11111111-1111-4111-8111-111111111111",
      }),
    });
    req.ip = "198.51.100.2";
    req.cookies = { remember_me: "abc" };
    expect((await run(req)).status).toBe(200);
    const [options] = mockCreateTicket.mock.calls[0];
    expect(options.ip_address).toBe("2001:db8::7");
    expect(options).not.toHaveProperty("account_id");
  });
});

describe("the body (direct-to-CoCalc ingress)", () => {
  it("a body longer than its Content-Length gives 400", async () => {
    const body = validBody();
    const r = await run(
      makeReq({ body, contentLength: `${Buffer.byteLength(body) - 5}` }),
    );
    expect(r.status).toBe(400);
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it("a body shorter than its Content-Length gives 400", async () => {
    const body = validBody();
    const r = await run(
      makeReq({ body, contentLength: `${Buffer.byteLength(body) + 5}` }),
    );
    expect(r.status).toBe(400);
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it("a body some parser already consumed gives 400", async () => {
    const req = makeReq();
    req._body = true;
    expect((await run(req)).status).toBe(400);
    expect(logLines.join("\n")).toContain("intake-body-preparsed");
  });

  it.each([
    ["not JSON", "hello"],
    ["an array", "[]"],
    ["trailing data", validBody() + "x"],
    ["two objects", validBody() + validBody()],
    ["a nested object", validBody({ title: { a: 1 } })],
    ["a number", validBody({ kind: 1 })],
    ["null", validBody({ email: null })],
    ["an unknown key", validBody({ source: "x" })],
    [
      "account_id",
      validBody({ account_id: "11111111-1111-4111-8111-111111111111" }),
    ],
    ["skip_email_rules", validBody({ skip_email_rules: "true" })],
    ["extra_tags", validBody({ extra_tags: "admin" })],
    ["an unknown kind", validBody({ kind: "billing" })],
    [
      "a non-v4 uuid",
      validBody({ submission_id: "0f8fad5b-d9cb-169f-a165-70867728950e" }),
    ],
    ["a short title", validBody({ title: "abcd" })],
    ["a long title", validBody({ title: "t".repeat(181) })],
    ["a short description", validBody({ description: "too short" })],
    ["a long description", validBody({ description: "d".repeat(19_001) })],
    ["a long email", validBody({ email: "e".repeat(245) + "@example.com" })],
    // JSON.stringify writes a lone surrogate as the escape \ud800
    ["a lone surrogate", validBody({ title: "abc \ud800 def" })],
  ])("%s gives 400 before any attempt", async (_label, body) => {
    const r = await run(makeReq({ body }));
    expect(r.status).toBe(400);
    expect(r.cache).toBe("no-store");
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it("a duplicate key gives 400, also when one copy is escaped", async () => {
    const body = validBody();
    for (const dup of [
      '{"title":"Another title here",' + body.slice(1),
      '{"\\u0074itle":"Another title here",' + body.slice(1),
    ]) {
      expect((await run(makeReq({ body: dup }))).status).toBe(400);
    }
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it("invalid UTF-8 gives 400", async () => {
    const body = Buffer.concat([
      Buffer.from(validBody().slice(0, -2)),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}'),
    ]);
    expect((await run(makeReq({ body }))).status).toBe(400);
  });

  it("titles and descriptions at their bounds are accepted", async () => {
    for (const extra of [
      { title: "t".repeat(5) },
      { title: "t".repeat(180) },
      { description: "d".repeat(10) },
      { description: "d".repeat(19_000) },
    ]) {
      expect((await run(makeReq({ body: validBody(extra) }))).status).toBe(200);
    }
  });

  it("every kind with a 180-unit title composes a subject of at most 200", () => {
    for (const kind of KINDS) {
      const request = {
        submission_id: SUBMISSION,
        kind,
        title: "t".repeat(180),
        description: "d".repeat(19_000),
      };
      expect(composeSubject(request).length).toBeLessThanOrEqual(200);
      expect(composeBody(request).length).toBeLessThanOrEqual(20_000);
    }
  });
});

describe("createTicket outcomes", () => {
  it("a rate-limit refusal gives 429", async () => {
    mockCreateTicket.mockRejectedValue(new MockRateLimitError("too many"));
    const r = await run(makeReq());
    expect(r).toEqual({
      status: 429,
      body: { error: "rate-limited" },
      cache: "no-store",
    });
  });

  it("any other failure (database, missing column, Zendesk) gives 503", async () => {
    mockCreateTicket.mockRejectedValue(
      Error(
        'column "source" of relation "support_ticket_attempts" does not exist',
      ),
    );
    const r = await run(makeReq());
    expect(r).toEqual({
      status: 503,
      body: { error: "unavailable" },
      cache: "no-store",
    });
  });
});
