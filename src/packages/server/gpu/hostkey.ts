/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key, step 4: a pod's one-time SSH host-key report, and
what a project needs to reach the pod (see ~/ops2/runpod/HOSTKEY-REGISTRATION.md,
approved 10-28).

registerHostKeyLocal runs on the token's authority bay (where the pod's
gpu_pods row is). The consume is one conditional UPDATE: the right token
(by id and verifier), not yet used, not expired, the pod bound to exactly the
reporting RunPod pod id, and the pod running with no terminate requested.
It writes the key and its audit event in one transaction.

If that UPDATE misses, the row is looked up again by token id AND verifier:
a wrong or unknown secret is always 401 and reveals nothing about the pod.
Only the holder of the right secret learns why, in this order:
  consumed with the same key and pod (a retried lost response): 200
  consumed with a different key: 409, and a host_key_mismatch alert
  bound to a different pod: 403, and a pod_id_mismatch alert
  not bound yet: 409 (the pod retries)
  expired or no longer running: 410

Once the key that launched the pod is removed, its token can't register
(410), and removing the key clears it (see hostkey-clear.ts).

HOSTKEY_IDEMPOTENCY_WINDOW_MS after use or after expiry, the token is
simply unknown (401): a report retires its own row's verifier then, and
clearStaleHostkeyTokens() retires the rest periodically.

Nothing here logs a token, a secret or a request.
*/

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  HOSTKEY_IDEMPOTENCY_WINDOW_MS,
  hostkeyVerifier,
  type HostkeyToken,
} from "@cocalc/server/gpu/hostkey-token";
import {
  findPod,
  gpuPodHomeClient,
  requireAccount,
  requireHomeBay,
  type GpuPodDeps,
} from "@cocalc/server/gpu/pods";
import { getRunpodCleanupForAccount } from "@cocalc/server/gpu/provider-keys";
import { parseEd25519PublicKey } from "@cocalc/util/gpu/ssh-key";
import type { GpuHostKeyResult, GpuPodSshInfo } from "@cocalc/util/gpu/types";

export type { GpuHostKeyResult, GpuPodSshInfo } from "@cocalc/util/gpu/types";

type HostkeyResult = GpuHostKeyResult;

const R = (
  status: GpuHostKeyResult["status"],
  result: GpuHostKeyResult["result"],
): GpuHostKeyResult => ({
  status,
  result,
});

async function event(
  client: { query: (q: string, p?: any[]) => Promise<any> },
  pod_id: string,
  details: Record<string, unknown>,
) {
  await client.query(
    `INSERT INTO gpu_pod_events (id, pod_id, at, actor_kind, action, details)
     VALUES ($1, $2, now(), 'pod', 'host_key', $3)`,
    [randomUUID(), pod_id, details],
  );
}

export async function registerHostKeyLocal(opts: {
  token: HostkeyToken;
  pod_id: string;
  host_public_key: string;
}): Promise<HostkeyResult> {
  const { token, pod_id } = opts;
  // A token minted elsewhere was routed here by mistake: refuse, reveal nothing.
  if (token.authority_bay_id !== getConfiguredBayId()) {
    return R(401, "unauthorized");
  }
  let key: { line: string; fingerprint: string };
  try {
    key = parseEd25519PublicKey(opts.host_public_key);
  } catch {
    return R(400, "invalid");
  }
  const verifier = hostkeyVerifier(token);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Everything below is keyed by the token id (unique, indexed): a report
    // never touches another pod's row.
    const consumed = await client.query(
      `UPDATE gpu_pods
          SET hostkey_consumed_at = now(), host_public_key = $3,
              host_key_fingerprint = $4, updated = now()
        WHERE hostkey_token_id = $1 AND hostkey_verifier = $2
          AND hostkey_consumed_at IS NULL AND hostkey_expires > now()
          AND provider_pod_id IS NOT NULL AND provider_pod_id = $5
          AND state = 'running' AND desired_state = 'running'
          AND EXISTS (SELECT 1 FROM external_credentials ec
                       WHERE ec.id = gpu_pods.credential_id AND ec.revoked IS NULL)
        RETURNING id`,
      [token.token_id, verifier, key.line, key.fingerprint, pod_id],
    );
    if (consumed.rows.length === 1) {
      await event(client, consumed.rows[0].id, {
        provider_pod_id: pod_id,
        host_key_fingerprint: key.fingerprint,
      });
      await client.query("COMMIT");
      return R(200, "registered");
    }
    // Only the holder of the right secret learns why.
    const { rows } = await client.query(
      `SELECT id, provider_pod_id, state, desired_state, host_public_key,
              hostkey_consumed_at, hostkey_expires > now() AS live,
              COALESCE(hostkey_consumed_at, hostkey_expires)
                <= now() - ($3::bigint * interval '1 millisecond') AS stale,
              EXISTS (SELECT 1 FROM external_credentials ec
                       WHERE ec.id = gpu_pods.credential_id AND ec.revoked IS NULL)
                AS key_active
         FROM gpu_pods
        WHERE hostkey_token_id = $1 AND hostkey_verifier = $2
        FOR UPDATE`,
      [token.token_id, verifier, HOSTKEY_IDEMPOTENCY_WINDOW_MS],
    );
    const row = rows[0];
    let result: HostkeyResult;
    if (row == null) {
      result = R(401, "unauthorized");
    } else if (row.stale) {
      // A window past use or expiry: retire this row's verifier (only this
      // row), and the token is unknown from now on.
      await client.query(
        `UPDATE gpu_pods SET hostkey_token_id = NULL, hostkey_verifier = NULL
          WHERE id = $1`,
        [row.id],
      );
      result = R(401, "unauthorized");
    } else if (!row.key_active) {
      // The key that launched the pod was removed.
      result = R(410, "gone");
    } else if (row.hostkey_consumed_at != null) {
      if (row.host_public_key === key.line && row.provider_pod_id === pod_id) {
        result = R(200, "registered");
      } else {
        result = R(409, "key_mismatch");
        await event(client, row.id, {
          alert: "host_key_mismatch",
          provider_pod_id: pod_id,
          host_key_fingerprint: key.fingerprint,
        });
      }
    } else if (row.provider_pod_id != null && row.provider_pod_id !== pod_id) {
      result = R(403, "pod_mismatch");
      await event(client, row.id, {
        alert: "pod_id_mismatch",
        provider_pod_id: pod_id,
      });
    } else if (row.provider_pod_id == null && row.live) {
      result = R(409, "not_bound");
    } else {
      result = R(410, "gone");
    }
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- what a project needs to reach a pod ----

export async function gpuSshInfoLocal(
  opts: { account_id?: string; pod_id?: unknown },
  deps: GpuPodDeps = {},
): Promise<GpuPodSshInfo> {
  const account_id = requireAccount(opts.account_id);
  await requireHomeBay(account_id, deps);
  const pod: any = await findPod(account_id, opts.pod_id);
  if (!pod) throw Error("No such GPU pod.");
  const info: GpuPodSshInfo = {
    handle: pod.handle,
    ready: false,
    state: pod.state,
  };
  if (pod.ssh_key_fingerprint)
    info.ssh_key_fingerprint = pod.ssh_key_fingerprint;
  if (
    pod.state !== "running" ||
    pod.desired_state !== "running" ||
    !pod.host_public_key ||
    !pod.provider_pod_id
  ) {
    return info;
  }
  // Defense in depth: what we hand out must still be one valid key.
  let hostKey: { line: string; fingerprint: string };
  try {
    hostKey = parseEd25519PublicKey(pod.host_public_key);
  } catch {
    return info;
  }
  // The live SSH endpoint (it changes when a pod restarts).
  const c = await (deps.getCleanup ?? getRunpodCleanupForAccount)(
    pod.key_owner_account_id,
  );
  // Only the key that launched the pod can see it (a replaced key may act
  // for another RunPod account).
  if (!c || c.credential_id !== pod.credential_id) return info;
  let live: Awaited<ReturnType<typeof c.getPod>>;
  try {
    live = await c.getPod(pod.provider_pod_id);
  } catch {
    throw Error("RunPod could not be reached. Try again shortly.");
  }
  const direct = live?.sshDirect;
  if (!direct) return info;
  return {
    ...info,
    ready: true,
    host: direct.host,
    port: direct.port,
    user: direct.username,
    host_public_key: hostKey.line,
    host_key_fingerprint: hostKey.fingerprint,
  };
}

export async function gpuSshInfo(
  opts: { account_id?: string; pod_id?: unknown },
  deps: GpuPodDeps = {},
): Promise<GpuPodSshInfo> {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? gpuPodHomeClient)(account_id);
  if (home) return await home.gpuSshInfo({ account_id, pod_id: opts.pod_id });
  return await gpuSshInfoLocal({ ...opts, account_id }, deps);
}
