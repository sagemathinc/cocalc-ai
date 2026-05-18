import type {
  CreateOrUpdateTicket,
  Type,
} from "node-zendesk/dist/types/clients/core/tickets";

import { getLogger } from "@cocalc/backend/logger";
import siteURL from "@cocalc/database/settings/site-url";
import getName, { getNameByEmail } from "@cocalc/server/accounts/get-name";
import { urlToUserURL } from "./util";
import getClient from "./zendesk-client";
import { assertSupportTicketRateLimit } from "./rate-limit";
import {
  is_valid_email_address as isValidEmailAddress,
  isValidUUID,
} from "@cocalc/util/misc";

const log = getLogger("support:create-ticket");
const MAX_FILES = 5;
const MAX_SUBJECT_LENGTH = 200;
const MIN_SUBJECT_LENGTH = 5;
const MAX_BODY_LENGTH = 20_000;
const MIN_BODY_LENGTH = 10;
const MAX_FINAL_BODY_LENGTH = 30_000;
const MAX_URL_LENGTH = 2_048;
const MAX_PATH_LENGTH = 4_096;
const MAX_BROWSER_LENGTH = 256;
const MAX_USER_AGENT_LENGTH = 1_024;
const MAX_CONTEXT_LENGTH = 4_096;

interface Options {
  email: string;
  account_id?: string;
  ip_address?: string;
  files?: { project_id: string; path?: string }[];
  type?: Type;
  subject?: string;
  body?: string;
  url?: string;
  info?: {
    userAgent?: string;
    browser?: string;
    context?: string;
  };
}

export function ticketResultToUserURL(ticketResult: any): string {
  return urlToUserURL(ticketResult?.result?.url ?? ticketResult?.url);
}

export async function normalizeZendeskBody(body: string): Promise<string> {
  const baseUrl = (await siteURL()).replace(/\/+$/, "");

  function absoluteBlobUrl(raw: string): string {
    const value = `${raw ?? ""}`.trim();
    if (!value) return value;
    if (value.startsWith("/blobs/")) return `${baseUrl}${value}`;
    if (value.startsWith("blobs/")) return `${baseUrl}/${value}`;
    return value;
  }

  const imgTag = /<img\b[^>]*\bsrc=(["'])(.*?)\1[^>]*>/gi;
  const markdownImage = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

  return body
    .replace(
      imgTag,
      (_match, _quote, src) => `\n- Image: ${absoluteBlobUrl(src)}\n`,
    )
    .replace(
      markdownImage,
      (_match, src) => `\n- Image: ${absoluteBlobUrl(src)}\n`,
    );
}

export default async function createTicket(options: Options): Promise<string> {
  const normalized = normalizeSupportTicketOptions(options);
  log.debug("createTicket", normalized);

  const { account_id, email, files, type, subject, url, info, ip_address } =
    normalized;
  await assertSupportTicketRateLimit({ account_id, email, ip_address });

  const client = await getClient();
  const name = await getUserName(email, account_id);

  let body: string = await normalizeZendeskBody(normalized.body);

  if (url) {
    body += `\n\n\nURL:\n${url}\n`;
  }
  if (files && files.length > 0) {
    body += "\n\n\nRELEVANT FILES:\n\n";
    for (const file of files) {
      body += `\n\n- ${await toURL(file)}\n`;
    }
  }
  if (info) {
    body += "\n\n\nBROWSER INFO:\n\n";
    body += `\n\n- userAgent="${info.userAgent}"`;
    body += `\n\n- browser="${info.browser}"`;
    if (info.context) {
      body += `\n\n- context="${info.context}"`;
    }
  }

  body += "\n\n\nUSER:\n\n";
  body += `\n\n- account_id="${account_id}"`;
  body += `\n\n- email="${email}"`;
  if (body.length > MAX_FINAL_BODY_LENGTH) {
    throw Error(`support ticket body must be at most ${MAX_FINAL_BODY_LENGTH}`);
  }

  // It's very helpful to look https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/node-zendesk/index.d.ts
  // and
  // https://github.com/blakmatrix/node-zendesk/tree/master/examples
  // https://developer.zendesk.com/api-reference/
  const ticket = {
    ticket: {
      comment: { body },
      external_id: account_id,
      subject,
      type,
      requester: { name, email },
    },
  } as CreateOrUpdateTicket; // ATTN: this is somehow necessary, no idea why

  log.debug("ticket ", ticket);

  const ticketResult = await client.tickets.create(ticket);
  log.debug("got ", { ticketResult });
  return ticketResultToUserURL(ticketResult);
}

type NormalizedOptions = Omit<Options, "email" | "body" | "subject"> &
  Required<Pick<Options, "email" | "body" | "subject">>;

export function normalizeSupportTicketOptions(
  options: Options,
): NormalizedOptions {
  const email = `${options?.email ?? ""}`.trim().toLowerCase();
  if (!isValidEmailAddress(email)) {
    throw Error("support ticket email must be valid");
  }

  const subject = `${options?.subject ?? ""}`.trim();
  if (
    subject.length < MIN_SUBJECT_LENGTH ||
    subject.length > MAX_SUBJECT_LENGTH
  ) {
    throw Error(
      `support ticket subject must be between ${MIN_SUBJECT_LENGTH} and ${MAX_SUBJECT_LENGTH} characters`,
    );
  }

  const body = `${options?.body ?? ""}`.trim();
  if (body.length < MIN_BODY_LENGTH || body.length > MAX_BODY_LENGTH) {
    throw Error(
      `support ticket body must be between ${MIN_BODY_LENGTH} and ${MAX_BODY_LENGTH} characters`,
    );
  }

  const url = optionalString(options?.url, MAX_URL_LENGTH, "url");
  const files = normalizeFiles(options?.files);
  const info = normalizeInfo(options?.info);
  const normalized: NormalizedOptions = {
    email,
    subject,
    body,
  };
  if (options.account_id != null) normalized.account_id = options.account_id;
  if (options.ip_address != null) normalized.ip_address = options.ip_address;
  if (options.type != null) normalized.type = options.type;
  if (url != null) normalized.url = url;
  if (files != null) normalized.files = files;
  if (info != null) normalized.info = info;
  return normalized;
}

function normalizeFiles(files: Options["files"]): Options["files"] {
  if (files == null) return undefined;
  if (!Array.isArray(files)) {
    throw Error("support ticket files must be an array");
  }
  if (files.length > MAX_FILES) {
    throw Error(`support ticket files must contain at most ${MAX_FILES} files`);
  }
  return files.map((file, i) => {
    const project_id = `${file?.project_id ?? ""}`.trim();
    if (!isValidUUID(project_id)) {
      throw Error(`support ticket files[${i}].project_id must be a valid uuid`);
    }
    const path = optionalString(file?.path, MAX_PATH_LENGTH, "file path");
    return path == null ? { project_id } : { project_id, path };
  });
}

function normalizeInfo(info: Options["info"]): Options["info"] {
  if (info == null) return undefined;
  if (typeof info !== "object") {
    throw Error("support ticket info must be an object");
  }
  const browser = optionalString(info.browser, MAX_BROWSER_LENGTH, "browser");
  const userAgent = optionalString(
    info.userAgent,
    MAX_USER_AGENT_LENGTH,
    "userAgent",
  );
  const context = optionalString(info.context, MAX_CONTEXT_LENGTH, "context");
  const normalized = {
    ...(browser != null ? { browser } : {}),
    ...(userAgent != null ? { userAgent } : {}),
    ...(context != null ? { context } : {}),
  };
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function optionalString(
  value: unknown,
  maxLength: number,
  label: string,
): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw Error(`support ticket ${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) {
    throw Error(`support ticket ${label} must be at most ${maxLength}`);
  }
  return normalized;
}

async function toURL({
  project_id,
  path,
}: {
  project_id: string;
  path?: string;
}) {
  let s = (await siteURL()) + "/" + encodeURI(`projects/${project_id}`);
  if (!path) return s;
  return s + encodeURI(`/files/${path}`);
}

async function getUserName(
  email: string,
  account_id?: string,
): Promise<string> {
  let name: string | undefined = undefined;
  if (account_id) {
    name = await getName(account_id);
  }
  if (!name) {
    name = await getNameByEmail(email);
  }
  // name: must be at least one character, even " " is causing errors
  // https://developer.zendesk.com/rest_api/docs/core/users
  if (!name?.trim()) {
    name = email;
  }
  return name;
}
