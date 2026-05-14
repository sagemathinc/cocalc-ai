/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { WebappClient } from "./client";
import api from "./api";

export class AdminClient {
  private client: WebappClient;

  constructor(client: WebappClient) {
    this.client = client;
  }

  public async admin_ban_user(
    account_id: string,
    ban: boolean = true, // if true, ban user  -- if false, remove ban
  ): Promise<void> {
    if (ban) {
      await api("/accounts/ban", { account_id });
    } else {
      await api("/accounts/remove-ban", { account_id });
    }
  }

  public async create_impersonation_grant(opts: {
    subject_account_id: string;
    reason?: string | null;
    lang_temp?: string | null;
  }): Promise<{
    grant_id: string;
    subject_account_id: string;
    subject_home_bay_id: string;
    home_bay_url?: string;
    url: string;
    expires_at: Date;
  }> {
    return await this.client.conat_client.hub.system.createImpersonationGrant({
      browser_id: this.client.browser_id,
      subject_account_id: opts.subject_account_id,
      reason: opts.reason,
      lang_temp: opts.lang_temp,
    });
  }
}
