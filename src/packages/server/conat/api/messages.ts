import send0 from "@cocalc/server/messages/send";
import { isValidUUID } from "@cocalc/util/misc";
import getPool from "@cocalc/database/pool";
import isAdmin from "@cocalc/server/accounts/is-admin";
import getAdmins from "@cocalc/server/accounts/admins";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getSingleBayInfo } from "@cocalc/server/bay-directory";
import { getProjectRecoveryNotificationConfiguration } from "@cocalc/server/projects/recovery-notification-configuration";

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

/** Send a labeled, idempotent critical-lane test to this bay's named on-call. */
export async function sendProjectRecoveryCriticalEmailDrill({
  account_id,
  drill_id,
}: {
  account_id?: string;
  drill_id: string;
}): Promise<{
  message_id: number;
  recipient_account_id: string;
  drill_id: string;
}> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("only admin may send project recovery critical email drills");
  }
  if (!isValidUUID(drill_id)) {
    throw Error("a valid drill_id UUID is required");
  }
  const settings = await getServerSettings();
  const { oncallAccountId, criticalEmailBackend } =
    getProjectRecoveryNotificationConfiguration(settings);
  if (!oncallAccountId || !(await getAdmins()).includes(oncallAccountId)) {
    throw Error("a local administrator must be configured as recovery on-call");
  }
  if (!criticalEmailBackend || criticalEmailBackend === "none") {
    throw Error("critical email backend is unavailable");
  }
  const bayId = getSingleBayInfo().bay_id;
  const messageId = await send0({
    to_ids: [oncallAccountId],
    subject: `Admin Alert - TEST project recovery critical email drill on ${bayId}: ${drill_id}`,
    body: [
      "TEST ONLY: This is a project recovery critical email delivery drill.",
      "No project debt or production incident is implied by this message.",
      `Owning bay: ${bayId}`,
      `Drill ID: ${drill_id}`,
      "Confirm receipt and verify that the email arrived through the critical lane.",
    ].join("\n"),
    dedupMinutes: 60,
    dedupBySubject: true,
    requireAccountNoticeDelivery: true,
    operationalIncident: true,
  });
  if (messageId == null) throw Error("critical email drill was not queued");
  return {
    message_id: messageId,
    recipient_account_id: oncallAccountId,
    drill_id,
  };
}
