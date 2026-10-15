/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The computer's login transcript (see server/computers/sessions.ts): signed
// by the computer's own key over a single-use challenge from its home bay.

import {
  MAX_LOGIN_MS,
  parseComputerChallengeRequest,
  parseComputerLogin,
  SIGNED_KINDS,
  type ComputerCertificate,
  type ComputerChallengeRequest,
  type ComputerLogin,
  type SignedEnvelope,
} from "@cocalc/util/computers/protocol";
import {
  canonicalHash,
  randomNonce,
  signEnvelope,
  type KeyPair,
} from "./crypto";

/**
 * What the challenge endpoint answers instead of a challenge when the home
 * bay ended this computer (revoked, replaced or its account deleted): its
 * signed state with `ended`, which the daemon verifies before acting on it.
 */
export interface LoginEnded {
  ended: unknown;
}

export type LoginChallengeAnswer = LoginChallengeView | LoginEnded;

export function isLoginEnded(value: unknown): value is LoginEnded {
  return value != null && typeof value === "object" && "ended" in value;
}

export interface LoginChallengeView {
  challenge_id: string;
  nonce: string;
  expires_at: number;
}

export function signComputerLogin({
  challenge,
  certificate,
  key,
  now = Date.now(),
}: {
  challenge: LoginChallengeView;
  certificate: SignedEnvelope<ComputerCertificate>;
  key: KeyPair;
  now?: number;
}): SignedEnvelope<ComputerLogin> {
  const c = certificate.payload;
  if (key.fingerprint !== c.signing_key) {
    throw new Error("this key is not the certificate's key");
  }
  const login = parseComputerLogin({
    type: "cocalc-computer-login",
    version: 1,
    site: c.site,
    cluster_id: c.cluster_id,
    home_bay_id: c.home_bay_id,
    home_epoch: c.home_epoch,
    computer_id: c.computer_id,
    account_id: c.account_id,
    certificate_hash: canonicalHash(certificate),
    signing_key: c.signing_key,
    audience: "conat",
    challenge_id: challenge.challenge_id,
    nonce: challenge.nonce,
    issued_at: now,
    expires_at: Math.min(now + MAX_LOGIN_MS, challenge.expires_at),
  });
  return signEnvelope(SIGNED_KINDS.login, login, key);
}

/**
 * Ask for a login challenge, signed by the computer's key and bound to the
 * identity in its certificate (site, cluster, home bay, account, computer),
 * with a single-use nonce.
 */
export function signChallengeRequest({
  certificate,
  key,
  now = Date.now(),
}: {
  certificate: SignedEnvelope<ComputerCertificate>;
  key: KeyPair;
  now?: number;
}): SignedEnvelope<ComputerChallengeRequest> {
  const c = certificate.payload;
  return signEnvelope(
    SIGNED_KINDS.challenge_request,
    parseComputerChallengeRequest({
      type: "cocalc-computer-challenge-request",
      version: 1,
      site: c.site,
      cluster_id: c.cluster_id,
      home_bay_id: c.home_bay_id,
      account_id: c.account_id,
      computer_id: c.computer_id,
      issued_at: now,
      nonce: randomNonce(),
    }),
    key,
  );
}
