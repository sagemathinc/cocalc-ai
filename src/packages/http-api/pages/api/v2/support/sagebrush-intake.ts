/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Support requests from sagebrush.space, sent by the Sagebrush support Worker
(never by browsers). The Worker holds the shared intake key and passes the
real client IP; CoCalc creates the Zendesk ticket exactly as its own support
form does, in a separate rate-limit namespace.

The steps run in a fixed order and fail closed. Nothing is recorded and
createTicket is not called before the request has passed every check:

1. method and headers, before any body byte is read;
2. the intake key (constant-time digest comparison against every configured
   key, no early exit);
3. the client IP header, read only after the key is valid;
4. a bounded raw read of the body;
5. a strict parse of one flat JSON object (duplicate keys rejected);
6. the policy, chosen here and never by the body;
7. createTicket, whose single rate-limit check runs in the intake namespace.

Every answer is `{ok: true}` or `{error: <fixed code>}`, with no-store.
*/

import { createHash, timingSafeEqual } from "crypto";
import { isIP } from "net";
import type { Request, Response } from "express";

import { getLogger } from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings";
import createTicket, {
  normalizeSupportTicketOptions,
} from "@cocalc/server/support/create-ticket";
import { SupportTicketRateLimitError } from "@cocalc/server/support/rate-limit";

const log = getLogger("support:sagebrush-intake");

// The shared API router skips its body parsers for this route (see
// RAW_BODY_ROUTES in lib/router.ts); this route bounds and parses its own body.
export const config = { api: { bodyParser: false } };

export const SAGEBRUSH_INTAKE_SOURCE = "sagebrush-intake";
export const MAX_BODY_BYTES = 131_072;
const READ_TIMEOUT_MS = 15_000;
const MAX_KEY_HEADER_BYTES = 64;
const MAX_IP_HEADER_BYTES = 45;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const KINDS = ["bug", "pkg", "feat", "book", "other"] as const;
const FIELDS = new Set([
  "submission_id",
  "kind",
  "title",
  "description",
  "email",
]);
const MIN_TITLE = 5;
const MAX_TITLE = 180;
const MIN_DESCRIPTION = 10;
const MAX_DESCRIPTION = 19_000;
const MAX_SUBJECT = 200;
const MAX_BODY = 20_000;
const MAX_EMAIL_BYTES = 254;

class IntakeError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

export interface IntakeRequest {
  submission_id: string;
  kind: (typeof KINDS)[number];
  title: string;
  description: string;
  email?: string;
}

export default async function handle(req: Request, res: Response) {
  try {
    await intake(req);
    reply(res, 200, { ok: true });
  } catch (err) {
    if (err instanceof IntakeError) {
      reply(res, err.status, { error: err.code });
    } else {
      log.warn("sagebrush intake failed", { code: "intake-internal-error" });
      reply(res, 503, { error: "unavailable" });
    }
  }
}

function reply(res: Response, status: number, body: object): void {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

async function intake(req: Request): Promise<void> {
  // 1. Method and headers, before any body byte is read.
  if (`${req.method ?? ""}`.toUpperCase() !== "POST") {
    throw new IntakeError(405, "method-not-allowed");
  }
  if (headerValues(req, "authorization").length > 0) {
    throw new IntakeError(400, "authorization-not-allowed");
  }
  const contentType = headerValues(req, "content-type");
  if (
    contentType.length !== 1 ||
    contentType[0].split(";")[0].trim().toLowerCase() !== "application/json"
  ) {
    throw new IntakeError(415, "unsupported-media-type");
  }
  if (headerValues(req, "transfer-encoding").length > 0) {
    throw new IntakeError(411, "length-required");
  }
  const contentLength = headerValues(req, "content-length");
  if (contentLength.length === 0) {
    throw new IntakeError(411, "length-required");
  }
  if (contentLength.length !== 1 || !/^[0-9]{1,16}$/.test(contentLength[0])) {
    throw new IntakeError(400, "bad-content-length");
  }
  const expectedBytes = Number(contentLength[0]);
  if (expectedBytes > MAX_BODY_BYTES) {
    throw new IntakeError(413, "too-large");
  }

  // 2. The intake key.
  let settings: Record<string, any>;
  try {
    settings = await getServerSettings();
  } catch {
    log.warn("sagebrush intake: settings unavailable", {
      code: "intake-settings-unavailable",
    });
    throw new IntakeError(503, "unavailable");
  }
  const keyDigests = parseIntakeKeys(settings.sagebrush_support_intake_key);
  if (keyDigests == null) {
    log.warn("sagebrush intake: route disabled", {
      code: "intake-key-config-invalid",
    });
    throw new IntakeError(503, "unavailable");
  }
  if (!keyMatches(headerValues(req, "x-sagebrush-intake-key"), keyDigests)) {
    throw new IntakeError(401, "unauthorized");
  }

  // 3. The client IP, only after the key is valid. Never req.ip, forwarded
  // headers, the body, cookies or account data.
  const ip_address = clientIp(headerValues(req, "x-sagebrush-client-ip"));

  // 4. A bounded raw read.
  const raw = await readBody(req, expectedBytes);

  // 5. A strict parse.
  const request = parseIntakeRequest(raw);
  const subject = composeSubject(request);
  const body = composeBody(request);
  if (subject.length > MAX_SUBJECT || body.length > MAX_BODY) {
    throw new IntakeError(400, "invalid-request");
  }

  // 6. The policy, chosen here. The default email (and only the default
  // chosen here, never a typed address) skips the rules keyed on the email.
  let email = request.email;
  const usesDefault = email == null;
  if (usesDefault) {
    email = `${settings.sagebrush_support_default_email ?? ""}`.trim();
    if (!email) {
      throw new IntakeError(400, "email-required");
    }
  }
  const options = { email: email!, subject, body, ip_address };
  // Validate and normalize before createTicket charges the quota, so that an
  // invalid request is a 400 and never an attempt row.
  try {
    normalizeSupportTicketOptions(options);
  } catch {
    throw new IntakeError(400, "invalid-request");
  }
  const internal = {
    source: SAGEBRUSH_INTAKE_SOURCE,
    skip_email_rules: usesDefault,
    extra_tags: [
      "sagebrush",
      `sb-kind-${request.kind}`,
      ...(usesDefault ? ["sb-no-email"] : []),
    ],
  };

  // 7. createTicket: its one rate-limit check runs in the intake namespace.
  // Its return value (the ticket URL) is never forwarded.
  try {
    await createTicket(options, internal);
  } catch (err) {
    if (err instanceof SupportTicketRateLimitError) {
      throw new IntakeError(429, "rate-limited");
    }
    log.warn("sagebrush intake: ticket not created", {
      code: "intake-ticket-failed",
    });
    throw new IntakeError(503, "unavailable");
  }
}

// All values of one header, from the raw header list, so a repeated header is
// seen as repeated rather than joined.
function headerValues(req: Request, name: string): string[] {
  const raw = (req as any).rawHeaders;
  if (Array.isArray(raw) && raw.length > 0) {
    const values: string[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (`${raw[i]}`.toLowerCase() === name) values.push(`${raw[i + 1]}`);
    }
    return values;
  }
  const value = req.headers?.[name];
  if (value == null) return [];
  return Array.isArray(value) ? value.map((v) => `${v}`) : [`${value}`];
}

// One key, or two different keys separated by a comma; anything else
// disables the route. Returns the keys' sha256 digests.
export function parseIntakeKeys(value: unknown): Buffer[] | undefined {
  if (typeof value !== "string") return;
  const keys = value.split(",");
  if (keys.length > 2 || !keys.every((key) => KEY.test(key))) return;
  if (keys.length === 2 && keys[0] === keys[1]) return;
  return keys.map(sha256);
}

function keyMatches(values: string[], digests: Buffer[]): boolean {
  if (values.length !== 1) return false;
  const value = values[0];
  if (Buffer.byteLength(value) > MAX_KEY_HEADER_BYTES) return false;
  const digest = sha256(value);
  let match = 0;
  for (const key of digests) {
    match |= timingSafeEqual(digest, key) ? 1 : 0;
  }
  return match === 1;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function clientIp(values: string[]): string {
  if (values.length !== 1) {
    throw new IntakeError(400, "bad-client-ip");
  }
  const value = values[0];
  if (
    Buffer.byteLength(value) > MAX_IP_HEADER_BYTES ||
    value.includes(",") ||
    isIP(value) === 0
  ) {
    throw new IntakeError(400, "bad-client-ip");
  }
  return value;
}

function readBody(req: Request, expectedBytes: number): Promise<Buffer> {
  // A body some parser already consumed can't be checked; refuse it.
  if ((req as any)._body === true || (req as any).readableEnded === true) {
    log.warn("sagebrush intake: body already read", {
      code: "intake-body-preparsed",
    });
    return Promise.reject(new IntakeError(400, "invalid-request"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (err?: IntakeError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onError);
      if (err) {
        req.pause?.();
        reject(err);
      } else {
        resolve(Buffer.concat(chunks, total));
      }
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        finish(new IntakeError(413, "too-large"));
      } else if (total > expectedBytes) {
        finish(new IntakeError(400, "length-mismatch"));
      } else {
        chunks.push(buf);
      }
    };
    const onEnd = () => {
      if (total !== expectedBytes) {
        finish(new IntakeError(400, "length-mismatch"));
      } else {
        finish();
      }
    };
    const onError = () => finish(new IntakeError(400, "invalid-request"));
    const timer = setTimeout(
      () => finish(new IntakeError(400, "body-timeout")),
      READ_TIMEOUT_MS,
    );
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onError);
  });
}

// One flat JSON object whose values are all strings: duplicate keys (after
// unescaping), unknown keys, and anything that isn't a string are refused.
export function parseIntakeRequest(raw: Buffer): IntakeRequest {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new IntakeError(400, "invalid-request");
  }
  const fields = parseFlatStringObject(text);
  if (fields == null) {
    throw new IntakeError(400, "invalid-request");
  }
  const { submission_id, kind, title, description, email } = fields;
  if (
    submission_id == null ||
    !UUID_V4.test(submission_id) ||
    kind == null ||
    !(KINDS as readonly string[]).includes(kind) ||
    title == null ||
    title.length < MIN_TITLE ||
    title.length > MAX_TITLE ||
    description == null ||
    description.length < MIN_DESCRIPTION ||
    description.length > MAX_DESCRIPTION ||
    (email != null && Buffer.byteLength(email) > MAX_EMAIL_BYTES)
  ) {
    throw new IntakeError(400, "invalid-request");
  }
  return {
    submission_id,
    kind: kind as IntakeRequest["kind"],
    title,
    description,
    ...(email != null ? { email } : {}),
  };
}

function parseFlatStringObject(
  text: string,
): Record<string, string> | undefined {
  const fields: Record<string, string> = Object.create(null);
  let i = skipSpace(text, 0);
  if (text[i] !== "{") return;
  i = skipSpace(text, i + 1);
  if (text[i] === "}") {
    return skipSpace(text, i + 1) === text.length ? fields : undefined;
  }
  for (;;) {
    const key = readString(text, i);
    if (key == null) return;
    if (!FIELDS.has(key.value) || key.value in fields) return;
    i = skipSpace(text, key.end);
    if (text[i] !== ":") return;
    const value = readString(text, skipSpace(text, i + 1));
    if (value == null) return;
    fields[key.value] = value.value;
    i = skipSpace(text, value.end);
    if (text[i] === ",") {
      i = skipSpace(text, i + 1);
    } else if (text[i] === "}") {
      return skipSpace(text, i + 1) === text.length ? fields : undefined;
    } else {
      return;
    }
  }
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && " \t\n\r".includes(text[i])) i++;
  return i;
}

// A JSON string starting at text[start]; JSON.parse decodes the scanned token,
// so its escapes follow JSON exactly. Lone surrogates are refused.
function readString(
  text: string,
  start: number,
): { value: string; end: number } | undefined {
  if (text[start] !== '"') return;
  let i = start + 1;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x22) break;
    if (c < 0x20) return;
    i += c === 0x5c ? 2 : 1;
  }
  if (i >= text.length) return;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, i + 1));
  } catch {
    return;
  }
  if (typeof value !== "string" || !isWellFormed(value)) return;
  return { value, end: i + 1 };
}

function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function composeSubject({ kind, title }: IntakeRequest): string {
  return `[sagebrush] ${kind}: ${title}`;
}

export function composeBody({
  submission_id,
  kind,
  description,
}: IntakeRequest): string {
  return `${description}\n\n---\nSent from the Sagebrush support page (sagebrush.space).\nkind: ${kind}\nsubmission: ${submission_id}\n`;
}
