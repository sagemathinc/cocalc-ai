/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { postSiteApi } from "./protocol";
import type { NormalizedSiteUrl } from "./site-url";

export interface LoginChallengeStart {
  challenge_id: string;
  poll_token: string;
  approval_url: string;
  expires_at: string | Date;
  home_bay_id?: string;
  home_bay_url?: string;
}

export interface LoginChallengeStatus {
  challenge_id: string;
  kind: "login";
  state: "pending" | "approved" | "redeemed";
  expires_at: string | Date;
  redeem_token?: string;
}

export interface RedeemedLogin {
  account_id: string;
  remember_me: string;
  expire: string | Date;
  home_bay_id?: string | null;
  home_bay_url?: string | null;
  email_address?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Sign-in was cancelled."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Sign-in was cancelled."));
      },
      { once: true },
    );
  });
}

export async function startLoginChallenge({
  site,
  email,
  signal,
}: {
  site: NormalizedSiteUrl;
  email?: string;
  signal?: AbortSignal;
}): Promise<LoginChallengeStart> {
  return await postSiteApi<LoginChallengeStart>({
    site,
    endpoint: "auth/cli/login/start",
    body: {
      ...(email?.trim() ? { email: email.trim() } : {}),
      client_kind: "mobile",
    },
    signal,
  });
}

export async function waitForLoginApproval({
  site,
  challenge,
  pollIntervalMs = 1_500,
  signal,
}: {
  site: NormalizedSiteUrl;
  challenge: LoginChallengeStart;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}): Promise<LoginChallengeStatus & { redeem_token: string }> {
  while (true) {
    const status = await postSiteApi<LoginChallengeStatus>({
      site,
      endpoint: "auth/cli/login/status",
      body: {
        challenge_id: challenge.challenge_id,
        poll_token: challenge.poll_token,
      },
      signal,
    });
    if (status.state === "approved" && status.redeem_token) {
      return status as LoginChallengeStatus & { redeem_token: string };
    }
    if (status.state !== "pending") {
      throw new Error(`Unexpected sign-in challenge state '${status.state}'.`);
    }
    const expiresAt = new Date(status.expires_at).valueOf();
    if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
      throw new Error("The sign-in approval expired. Start sign-in again.");
    }
    await delay(pollIntervalMs, signal);
  }
}

export async function redeemLoginChallenge({
  site,
  challenge,
  status,
  signal,
}: {
  site: NormalizedSiteUrl;
  challenge: LoginChallengeStart;
  status: LoginChallengeStatus & { redeem_token: string };
  signal?: AbortSignal;
}): Promise<RedeemedLogin> {
  return await postSiteApi<RedeemedLogin>({
    site,
    endpoint: "auth/cli/login/redeem",
    body: {
      challenge_id: challenge.challenge_id,
      redeem_token: status.redeem_token,
    },
    signal,
  });
}
