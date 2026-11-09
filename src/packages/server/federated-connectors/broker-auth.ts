/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The token broker as a principal on the fabric (G3b design v3 §3 and the v3.1
amendment; option (1) of the caller question).

- Authentication: the broker presents a Google ID token from its metadata
  server (audience = the cluster id). It's verified against Google's keys and
  the protected signer record (federated_broker_signer). The connection's user
  is { hub_id: "federated-broker", federated_broker_signer_id }, with its
  authorization lease ending at the token's expiry, so the server drops the
  connection and the broker reconnects with a fresh token.
- The conat server stamps that verified id on the broker's requests
  (AuthenticatedCaller.federated_broker_signer_id); bays recheck it against
  the current signer record.
- Exact access: publish to reply inboxes (the platform rule), the bays'
  federated-broker lookup subjects and its heartbeat subject; subscribe to the
  broker service subject and its own inbox namespace. Nothing else, including
  while the signer record no longer names it.
*/

import {
  canonicalFederatedSetting,
  FEDERATED_BROKER_SIGNER_SETTING,
} from "@cocalc/util/ai/federated-connectors";
import {
  GoogleIdentityError,
  GOOGLE_ID_TOKEN_ISSUERS,
  googleCertsSource,
  isGoogleUniqueId,
  verifyGoogleIdToken,
  type GoogleCerts,
  type SignerRecord,
  type TextFetch,
} from "./google-identity";

export const FEDERATED_BROKER_HUB_ID = "federated-broker";

export function brokerServiceSubject(cluster_id: string): string {
  return `broker.${cluster_id}.rpc.mint.v1`;
}
export function brokerHeartbeatSubject(cluster_id: string): string {
  return `broker.${cluster_id}.heartbeat.v1`;
}
export function brokerInboxPrefix(signer_id: string): string {
  return `_INBOX.broker-${signer_id}`;
}
export function bayBrokerLookupSubject(bay_id: string): string {
  return `bay.${bay_id}.rpc.federated-broker.v1`;
}

const CLUSTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BAY_LOOKUP_RE = /^bay\.[A-Za-z0-9_-]{1,64}\.rpc\.federated-broker\.v1$/;

/** The signer record from the protected setting, or undefined. */
export function signerRecordFromSetting(
  value: unknown,
): SignerRecord | undefined {
  const canonical = canonicalFederatedSetting(
    FEDERATED_BROKER_SIGNER_SETTING,
    value,
  );
  if (!canonical) return;
  const [email, uniqueId] = canonical.split(" ");
  return { email, uniqueId };
}

/** Whether a bearer token claims to be a Google ID token (by its issuer). */
export function looksLikeGoogleIdToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return GOOGLE_ID_TOKEN_ISSUERS.includes(payload?.iss);
  } catch {
    return false;
  }
}

export interface FederatedBrokerUser {
  hub_id: typeof FEDERATED_BROKER_HUB_ID;
  federated_broker_signer_id: string;
  auth_lease_exp_s: number;
}

let defaultCerts: (() => Promise<GoogleCerts>) | undefined;

/**
 * Authenticates a broker's bearer ID token, or throws. Fails closed when no
 * signer is recorded.
 */
export async function authenticateFederatedBroker({
  token,
  clusterId,
  signerSetting,
  certs,
  nowS,
}: {
  token: string;
  clusterId: string;
  signerSetting: unknown;
  certs?: () => Promise<GoogleCerts>;
  nowS?: number;
}): Promise<FederatedBrokerUser> {
  const signer = signerRecordFromSetting(signerSetting);
  if (signer == null || !CLUSTER_ID_RE.test(clusterId)) {
    throw new GoogleIdentityError("broker_not_configured");
  }
  if (certs == null) {
    defaultCerts ??= googleCertsSource((async (url, init) => {
      const res = await fetch(url, init);
      return { status: res.status, text: () => res.text() };
    }) as TextFetch);
    certs = defaultCerts;
  }
  const { sub, exp } = await verifyGoogleIdToken({
    token,
    audience: clusterId,
    signer,
    certs,
    nowS,
  });
  return {
    hub_id: FEDERATED_BROKER_HUB_ID,
    federated_broker_signer_id: sub,
    auth_lease_exp_s: exp,
  };
}

/**
 * The broker's exact access. `currentSignerId` is the signer record's id
 * now: a broker whose signer has been replaced gets nothing.
 */
export function isFederatedBrokerAllowed({
  signerId,
  currentSignerId,
  clusterId,
  subject,
  type,
}: {
  signerId: unknown;
  currentSignerId: string | undefined;
  clusterId: string;
  subject: string;
  type: "pub" | "sub";
}): boolean {
  if (
    !isGoogleUniqueId(signerId) ||
    currentSignerId == null ||
    signerId !== currentSignerId ||
    typeof subject !== "string"
  ) {
    return false;
  }
  if (type === "pub") {
    if (subject.startsWith("_INBOX.")) {
      // The platform rule (v3.1): any reply inbox, never a wildcard.
      return !subject.includes("*") && !subject.includes(">");
    }
    return (
      BAY_LOOKUP_RE.test(subject) ||
      subject === brokerHeartbeatSubject(clusterId)
    );
  }
  // Subscribe: the broker service and only its own inbox namespace.
  if (subject === brokerServiceSubject(clusterId)) return true;
  const own = `${brokerInboxPrefix(signerId)}.`;
  return subject.startsWith(own) && subject.length > own.length;
}
