/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSecretSettingsKey } from "@cocalc/database/settings/secret-settings";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { isValidUUID } from "@cocalc/util/misc";
import { ensurePeopleSchema } from "./schema";
import type { PeopleDb } from "./schema";

export function uuid(value: string, name: string) {
  if (!isValidUUID(value)) throw Error(`invalid ${name}`);
}
export function pageLimit(value = 50) {
  if (!Number.isInteger(value) || value < 1 || value > 100)
    throw Error("limit must be between 1 and 100");
  return value;
}
export function peopleSearch(value?: string) {
  if (
    value != null &&
    (typeof value !== "string" || value.length > 200 || value.includes("\0"))
  )
    throw Error("search must be at most 200 characters");
  return value?.trim() ?? "";
}
export async function peopleHome(account_id: string) {
  uuid(account_id, "account_id");
  const account = await getClusterAccountById(account_id);
  if (!account || account.banned || !account.home_bay_id)
    throw Error("people account unavailable");
  return account.home_bay_id;
}
export async function withPeopleAccount<T>(
  account_id: string,
  fn: (db: PeopleDb) => Promise<T>,
) {
  await ensurePeopleSchema();
  return withAccountRehomeWriteFence({
    account_id,
    action: "access private people state",
    fn: async (db) => {
      if ((await peopleHome(account_id)) !== getConfiguredBayId())
        throw Error("stale people account-home route");
      return fn(db);
    },
  });
}
type Cursor = {
  binding: string;
  revision: string;
  after: string[];
  expires: number;
};
async function sign(payload: string) {
  return createHmac("sha256", await getSecretSettingsKey())
    .update("people-cursor:v1\0")
    .update(payload)
    .digest("base64url");
}
export async function encodePeopleCursor(
  binding: string,
  revision: string,
  after: string[],
  expires = Date.now() + 15 * 60000,
) {
  const payload = Buffer.from(
    JSON.stringify({ binding, revision, after, expires }),
  ).toString("base64url");
  return `${payload}.${await sign(payload)}`;
}
export async function decodePeopleCursor(
  value: string | undefined,
  binding: string,
  revision: string,
): Promise<Cursor | undefined> {
  if (!value) return;
  if (value.length > 4096) throw Error("invalid people cursor");
  const [payload, signature, extra] = value.split(".");
  const expected = await sign(payload);
  if (
    extra ||
    !signature ||
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    throw Error("invalid people cursor");
  const cursor: Cursor = JSON.parse(
    Buffer.from(payload, "base64url").toString(),
  );
  if (cursor.binding !== binding || cursor.expires < Date.now())
    throw Error("invalid or expired people cursor");
  if (cursor.revision !== revision)
    throw Error("stale people cursor; restart pagination");
  if (
    !Array.isArray(cursor.after) ||
    !cursor.after.every((x) => typeof x === "string")
  )
    throw Error("invalid people cursor");
  return cursor;
}
