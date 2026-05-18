import send0 from "@cocalc/server/messages/send";
import { cloneDeep } from "lodash";
import { isValidUUID } from "@cocalc/util/misc";
import getPool from "@cocalc/database/pool";
import isAdmin from "@cocalc/server/accounts/is-admin";

const MAX_MESSAGE_RECIPIENTS = 25;
const MESSAGE_RATE_LIMIT_WINDOW_MINUTES = 60;
const MAX_MESSAGES_PER_WINDOW = 60;

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

async function assertTargetsAreCollaborators({
  from_id,
  to_ids,
}: {
  from_id: string;
  to_ids: string[];
}): Promise<void> {
  if (to_ids.length === 0) return;
  const { rows } = await getPool().query<{ account_id: string }>(
    `
      SELECT target.account_id::TEXT AS account_id
        FROM UNNEST($2::UUID[]) AS target(account_id)
       WHERE target.account_id = $1::UUID
          OR EXISTS (
            SELECT 1
              FROM account_collaborator_index
             WHERE account_id = $1::UUID
               AND collaborator_account_id = target.account_id
          )
          OR EXISTS (
            SELECT 1
              FROM projects
             WHERE COALESCE(deleted, FALSE) IS NOT TRUE
               AND (users -> $1::TEXT ->> 'group') IN ('owner', 'collaborator')
               AND (users -> target.account_id::TEXT ->> 'group') IN ('owner', 'collaborator')
          )
    `,
    [from_id, to_ids],
  );
  const allowed = new Set(rows.map(({ account_id }) => account_id));
  const denied = to_ids.filter((account_id) => !allowed.has(account_id));
  if (denied.length > 0) {
    throw Error("message recipients must be collaborators");
  }
}

async function assertSenderRateLimit(from_id: string): Promise<void> {
  const { rows } = await getPool().query<{ count: string }>(
    `
      SELECT COUNT(*)::TEXT AS count
        FROM messages
       WHERE from_id = $1::UUID
         AND sent >= NOW() - ($2::TEXT || ' minutes')::INTERVAL
    `,
    [from_id, MESSAGE_RATE_LIMIT_WINDOW_MINUTES],
  );
  if (Number(rows[0]?.count ?? 0) >= MAX_MESSAGES_PER_WINDOW) {
    throw Error("message rate limit exceeded");
  }
}

export async function send(opts) {
  if (!opts.account_id) {
    throw Error("invalid account");
  }
  const opts2: any = cloneDeep(opts);
  opts2.from_id = opts.account_id;
  opts2.to_ids = await resolveTargets(opts.to_ids ?? []);
  await assertTargetsAreCollaborators({
    from_id: opts2.from_id,
    to_ids: opts2.to_ids,
  });
  await assertSenderRateLimit(opts2.from_id);
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
