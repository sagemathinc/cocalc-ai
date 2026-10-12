/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The computer's login transcript (see server/computers/sessions.ts): signed
// by the computer's own key over a single-use challenge from its home bay.

import {
  MAX_LOGIN_MS,
  parseComputerLogin,
  SIGNED_KINDS,
  type ComputerCertificate,
  type ComputerLogin,
  type SignedEnvelope,
} from "@cocalc/util/computers/protocol";
import { canonicalHash, signEnvelope, type KeyPair } from "./crypto";

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
