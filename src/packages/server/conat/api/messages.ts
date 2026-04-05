import send0 from "@cocalc/server/messages/send";
import { cloneDeep } from "lodash";
import { isValidUUID } from "@cocalc/util/misc";
import getPool from "@cocalc/database/pool";
import isAdmin from "@cocalc/server/accounts/is-admin";

async function resolveTargets(to_ids: string[]): Promise<string[]> {
  const directTargets = to_ids.filter(isValidUUID);
  const emailTargets = to_ids.filter((x) => x.includes("@"));
  if (emailTargets.length === 0) {
    return directTargets;
  }
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT account_id FROM accounts WHERE email_address=ANY($1)",
    [emailTargets],
  );
  return [...directTargets, ...rows.map(({ account_id }) => account_id)];
}

export async function send(opts) {
  if (!opts.account_id) {
    throw Error("invalid account");
  }
  const opts2: any = cloneDeep(opts);
  opts2.from_id = opts.account_id;
  opts2.to_ids = await resolveTargets(opts.to_ids ?? []);
  return await send0(opts2);
}

export async function sendSystemNotice(opts) {
  if (!opts.account_id) {
    throw Error("invalid account");
  }
  if (!(await isAdmin(opts.account_id))) {
    throw Error("only admin may send system notices");
  }
  return await send0({
    to_ids: await resolveTargets(opts.to_ids ?? []),
    subject: opts.subject,
    body: opts.body,
    reply_id: opts.reply_id,
    dedupMinutes: opts.dedupMinutes,
  });
}

import get from "@cocalc/server/messages/get";
export { get };
