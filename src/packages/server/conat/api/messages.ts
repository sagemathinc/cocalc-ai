import send0 from "@cocalc/server/messages/send";
import { isValidUUID } from "@cocalc/util/misc";
import getPool from "@cocalc/database/pool";
import isAdmin from "@cocalc/server/accounts/is-admin";

const MAX_MESSAGE_RECIPIENTS = 25;

function normalizeRecipientInputs(to_ids: string[] = []): string[] {
  const recipients = Array.from(
    new Set(
      (Array.isArray(to_ids) ? to_ids : [])
        .map((id) => `${id ?? ""}`.trim())
        .filter(Boolean),
    ),
  );
  if (recipients.length > MAX_MESSAGE_RECIPIENTS) {
    throw Error(`at most ${MAX_MESSAGE_RECIPIENTS} recipients are allowed`);
  }
  return recipients;
}

async function resolveTargets(to_ids: string[]): Promise<string[]> {
  const normalized = normalizeRecipientInputs(to_ids);
  const directTargets = normalized.filter(isValidUUID);
  const emailTargets = normalized.filter((x) => x.includes("@"));
  if (emailTargets.length === 0) {
    return directTargets;
  }
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT account_id FROM accounts WHERE email_address=ANY($1)",
    [emailTargets],
  );
  const targets = Array.from(
    new Set([...directTargets, ...rows.map(({ account_id }) => account_id)]),
  );
  if (targets.length > MAX_MESSAGE_RECIPIENTS) {
    throw Error(`at most ${MAX_MESSAGE_RECIPIENTS} recipients are allowed`);
  }
  return targets;
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
