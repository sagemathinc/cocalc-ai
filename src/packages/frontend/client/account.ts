/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { callback } from "awaiting";
declare const $: any; // jQuery
import { WebappClient } from "./client";
import type { ApiKey } from "@cocalc/util/db-schema/api-keys";
import type { ApiKeyCapability } from "@cocalc/util/db-schema/api-keys";
import api from "./api";

export class AccountClient {
  private client: WebappClient;

  constructor(client: WebappClient) {
    this.client = client;
  }

  cookies = async (mesg): Promise<void> => {
    const f = (cb) => {
      const j = $.ajax({
        url: mesg.url,
        data: { id: mesg.id, set: mesg.set, get: mesg.get, value: mesg.value },
      });
      j.done(() => cb());
      j.fail(() => cb("failed"));
    };
    await callback(f);
  };

  sign_out = async (everywhere: boolean = false): Promise<void> => {
    await api("/accounts/sign-out", { all: everywhere });
    delete this.client.account_id;
    this.client.emit("signed_out");
  };

  change_password = async (
    currentPassword: string,
    newPassword: string = "",
  ): Promise<void> => {
    await api("/accounts/set-password", { currentPassword, newPassword });
  };

  change_email = async (
    new_email_address: string,
    password: string = "",
  ): Promise<{
    already_verified?: boolean;
    email_address?: string;
    verification_email_error?: string;
    verification_email_sent?: boolean;
  }> => {
    if (this.client.account_id == null) {
      throw Error("must be logged in");
    }
    return await api("accounts/set-email-address", {
      email_address: new_email_address,
      password,
    });
  };

  send_verification_email = async (
    only_verify: boolean = true,
  ): Promise<void> => {
    await this.client.conat_client.hub.system.sendEmailVerification({
      only_verify,
    });
  };

  // forget about a given passport authentication strategy for this user
  unlink_passport = async (strategy: string, id: string): Promise<void> => {
    await this.client.conat_client.hub.system.deletePassport({
      strategy,
      id,
    });
  };

  // Account API key management.
  api_keys = async (opts: {
    action: "get" | "delete" | "create" | "edit";
    password?: string;
    name?: string;
    capabilities?: ApiKeyCapability[];
    allowed_project_ids?: string[];
    id?: number;
    expire?: Date;
  }): Promise<ApiKey[] | undefined> => {
    return await this.client.conat_client.hub.system.manageApiKeys(opts);
  };
}
