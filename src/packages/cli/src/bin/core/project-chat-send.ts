import type { DB } from "@cocalc/conat/hub/api/db";

export { prepareChatSend, submitChatSend } from "@cocalc/chat/send";

export async function readChatSendAccountSettings(
  db: Pick<DB, "userQuery">,
  accountId: string,
) {
  const result = await db.userQuery({
    query: { accounts: [{ account_id: accountId, other_settings: null }] },
  });
  const account = result?.accounts?.find((row) => row.account_id === accountId);
  if (!account)
    throw new Error("could not read the sending account's preferences");
  return account.other_settings ?? {};
}
