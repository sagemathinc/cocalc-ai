import { authFirstRequireAccount } from "./util";

export interface Messages {
  sendSystemNotice: (opts: {
    account_id?: string;
    // to_ids -- account_id's or email addresses of users with accounts
    to_ids: string[];
    // short plain text formatted subject
    subject: string;
    // longer markdown formatted body
    body: string;
    reply_id?: number;
    dedupMinutes?: number;
  }) => Promise<number>;
}

export const messages = {
  sendSystemNotice: authFirstRequireAccount,
};
