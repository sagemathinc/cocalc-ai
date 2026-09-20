import { createHash, createPublicKey, verify } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { canonicalFundingTerms as stableStringify } from "./approvals";
import { FUNDING_WRITER_PROTOCOL_VERSION } from "@cocalc/util/compute-funding-rollout";
import {
  getConfiguredBayId,
  getConfiguredClusterBayCatalog,
} from "@cocalc/server/bay-config";
import {
  getConfiguredClusterSeedBayId,
  isMultiBayCluster,
} from "@cocalc/server/cluster-config";
import { listClusterBayRegistry } from "@cocalc/server/bay-registry";
import {
  FUNDING_ACCOUNT_WRITER_ROLES,
  FUNDING_RESOURCE_WRITER_ROLES,
} from "./production-rollout-contract";
import type {
  FundingRolloutManifest,
  FundingRolloutBay,
} from "./production-rollout-contract";
import { fundingAmount } from "@cocalc/util/compute-funding";
import { toDecimal } from "@cocalc/util/money";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_VALIDITY_MS = 15 * 60_000;

function object(value: unknown, keys: string[]): Record<string, any> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw Error("Invalid funding rollout manifest object.");
  return value as Record<string, any>;
}
function string(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\x00-\x1f]/.test(value)
  )
    throw Error("Invalid funding rollout manifest identity.");
  return value;
}
function array(value: unknown, max: number): any[] {
  if (!Array.isArray(value) || value.length > max)
    throw Error("Invalid funding rollout manifest list.");
  return value;
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length)
    throw Error("Duplicate funding rollout manifest identity.");
}
function date(value: unknown): number {
  const parsed = Date.parse(string(value));
  if (!Number.isFinite(parsed))
    throw Error("Invalid funding rollout manifest time.");
  return parsed;
}

/** Parse the complete signed contract, rejecting omissions and unknown fields.
 * Signature validation precedes interpreting any operational identities.
 */
export function verifyFundingRolloutManifest(
  raw: string,
  publicKey: string,
  now = Date.now(),
): { manifest: FundingRolloutManifest; digest: string } {
  if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES)
    throw Error("Funding rollout manifest exceeds size limit.");
  const envelope = object(JSON.parse(raw), ["manifest", "signature"]);
  const canonical = stableStringify(envelope.manifest);
  const signature = Buffer.from(string(envelope.signature), "base64");
  const key = createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    signature.length !== 64 ||
    !canonical ||
    !verify(null, Buffer.from(canonical), key, signature)
  )
    throw Error("Funding rollout manifest signature is invalid.");
  const m = object(envelope.manifest, [
    "kind",
    "version",
    "deployment_id",
    "rollout_id",
    "seed_bay_id",
    "issued_at",
    "expires_at",
    "bays",
    "exposure_allocation",
  ]);
  if (m.kind !== "cocalc-funding-rollout" || m.version !== 1)
    throw Error("Unsupported funding rollout manifest version.");
  string(m.deployment_id);
  string(m.rollout_id);
  string(m.seed_bay_id);
  const issued = date(m.issued_at),
    expires = date(m.expires_at);
  if (
    issued > now + 1000 ||
    expires <= now ||
    expires <= issued ||
    expires - issued > MAX_VALIDITY_MS
  )
    throw Error(
      "Funding rollout manifest is expired or outside its validity bound.",
    );
  const bays = array(m.bays, 32);
  if (!bays.length) throw Error("Funding rollout manifest has no bays.");
  unique(bays.map((b) => string(b.bay_id)));
  if (m.exposure_allocation !== undefined) {
    const allocation = object(m.exposure_allocation, [
      "id",
      "site_ceiling_usd",
      "bay_quotas",
    ]);
    string(allocation.id);
    const ceiling = fundingAmount(string(allocation.site_ceiling_usd), {
      positive: true,
    });
    const quotas = array(allocation.bay_quotas, 32);
    unique(quotas.map((q) => string(q.bay_id)));
    if (
      stableStringify(quotas.map((q) => q.bay_id).sort()) !==
      stableStringify(bays.map((b) => b.bay_id).sort())
    )
      throw Error(
        "Funding exposure allocation must cover exactly the attested bays.",
      );
    let total = toDecimal(0);
    for (const value of quotas) {
      const quota = object(value, ["bay_id", "amount_usd"]);
      total = total.plus(fundingAmount(string(quota.amount_usd)));
    }
    if (total.gt(ceiling))
      throw Error("Funding bay exposure quotas exceed the site ceiling.");
  } else if (bays.length > 1) {
    throw Error("Multi-bay funding requires an explicit exposure allocation.");
  }
  for (const value of bays) {
    const bay = object(value, [
      "bay_id",
      "namespace",
      "database",
      "writers",
      "resource_credentials",
      "retired_resource_credentials",
      "credential_rollout",
    ]);
    string(bay.bay_id);
    if (!/^[a-f0-9]{16}$/.test(string(bay.namespace)))
      throw Error("Invalid funding resource namespace.");
    const db = object(bay.database, [
      "system_identifier",
      "name",
      "trust_model",
      "writer_roles",
      "operator_roles",
      "retired_roles",
    ]);
    if (!/^\d+$/.test(string(db.system_identifier)))
      throw Error("Invalid PostgreSQL cluster identity.");
    string(db.name);
    const trustModel = string(db.trust_model);
    if (
      trustModel !== "isolated-writers" &&
      trustModel !== "co-resident-operator-writer"
    )
      throw Error("Unknown PostgreSQL funding trust model.");
    if (trustModel === "co-resident-operator-writer" && bays.length !== 1)
      throw Error(
        "The co-resident PostgreSQL funding trust model is limited to one-bay deployments.",
      );
    const writerRoles = array(db.writer_roles, 128).map(string);
    const operatorRoles = array(db.operator_roles, 128).map(string);
    if (!writerRoles.length)
      throw Error("No database writer roles are attested.");
    unique([...writerRoles, ...operatorRoles]);
    const roles = new Set<string>();
    const writers = array(bay.writers, 512);
    unique(writers.map((w) => string(w.id)));
    for (const value of writers) {
      const writer = object(value, [
        "id",
        "build_id",
        "protocol_version",
        "database_role",
        "roles",
      ]);
      string(writer.id);
      string(writer.build_id);
      if (
        writer.protocol_version !== FUNDING_WRITER_PROTOCOL_VERSION ||
        !writerRoles.includes(string(writer.database_role))
      )
        throw Error(
          "Funding writer version or database role is not supported.",
        );
      const coverage = array(writer.roles, 32).map(string);
      unique(coverage);
      if (!coverage.length)
        throw Error("Funding writer has no capability coverage.");
      for (const role of coverage) {
        if (
          ![
            ...FUNDING_ACCOUNT_WRITER_ROLES,
            ...FUNDING_RESOURCE_WRITER_ROLES,
          ].includes(role as any)
        )
          throw Error("Unknown funding writer capability.");
        roles.add(role);
      }
    }
    if (
      [...FUNDING_ACCOUNT_WRITER_ROLES, ...FUNDING_RESOURCE_WRITER_ROLES].some(
        (role) => !roles.has(role),
      ) ||
      writerRoles.some((role) => !writers.some((w) => w.database_role === role))
    )
      throw Error("Funding writer capability coverage is incomplete.");
    const rollout = object(bay.credential_rollout, [
      "epoch",
      "mode",
      "previous_epoch",
      "completed_at",
      "evidence_id",
    ]);
    string(rollout.epoch);
    string(rollout.evidence_id);
    const completed = date(rollout.completed_at);
    if (completed > issued)
      throw Error("Credential rollout was not complete when attested.");
    if (rollout.mode === "rotation") {
      if (string(rollout.previous_epoch) === rollout.epoch)
        throw Error("Credential rotation reuses its old epoch.");
    } else if (
      rollout.mode !== "bootstrap" ||
      rollout.previous_epoch !== undefined
    )
      throw Error("Invalid credential rollout mode.");
    for (const revocations of [
      array(db.retired_roles, 128),
      array(bay.retired_resource_credentials, 512),
    ]) {
      unique(revocations.map((r) => string(r.id)));
      for (const value of revocations) {
        const revocation = object(value, ["id", "revoked_at", "evidence_id"]);
        string(revocation.id);
        string(revocation.evidence_id);
        if (date(revocation.revoked_at) > completed)
          throw Error("Credential revocation was not complete before rollout.");
      }
      if (rollout.mode === "rotation" && !revocations.length)
        throw Error("Credential rotation lacks revocation evidence.");
    }
    if (
      db.retired_roles.some((r) =>
        [...writerRoles, ...operatorRoles].includes(r.id),
      )
    )
      throw Error(
        "Retired database credentials remain in the active inventory.",
      );
    const credentials = array(bay.resource_credentials, 512);
    unique(credentials.map((c) => `${c.provider}:${c.scope}`));
    for (const value of credentials) {
      const credential = object(value, [
        "provider",
        "scope",
        "identity",
        "key_id",
      ]);
      if (!["gcp", "nebius", "cloudflare"].includes(credential.provider))
        throw Error("Unsupported resource credential provider.");
      string(credential.scope);
      string(credential.identity);
      string(credential.key_id);
      if (
        bay.retired_resource_credentials.some(
          (r) => r.id === `${credential.provider}:${credential.key_id}`,
        )
      )
        throw Error("Retired resource credentials are still active.");
    }
  }
  return {
    manifest: m as FundingRolloutManifest,
    digest: createHash("sha256").update(canonical).digest("hex"),
  };
}

async function readOperatorFile(
  path: string | undefined,
  limit: number,
): Promise<string> {
  if (!path || !isAbsolute(path))
    throw Error(
      "Funding rollout requires explicitly configured operator files.",
    );
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.size > limit ||
      (metadata.mode & 0o022) !== 0 ||
      ![0, process.getuid?.()].includes(metadata.uid)
    )
      throw Error(
        "Funding rollout files must be bounded and owned by the trusted operator.",
      );
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw Error("Funding rollout file exceeds size limit.");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function loadProductionFundingRollout(): Promise<{
  manifest: FundingRolloutManifest;
  bay: FundingRolloutBay;
  digest: string;
}> {
  const raw = await readOperatorFile(
    process.env.COCALC_FUNDING_ROLLOUT_MANIFEST,
    MAX_MANIFEST_BYTES,
  );
  const key = await readOperatorFile(
    process.env.COCALC_FUNDING_ROLLOUT_PUBLIC_KEY,
    16_384,
  );
  const result = verifyFundingRolloutManifest(raw, key);
  const { manifest } = result;
  if (
    !process.env.COCALC_FUNDING_ROLLOUT_ID ||
    manifest.rollout_id !== process.env.COCALC_FUNDING_ROLLOUT_ID ||
    manifest.deployment_id !== process.env.COCALC_COMPUTE_DEPLOYMENT_ID ||
    manifest.seed_bay_id !== getConfiguredClusterSeedBayId()
  )
    throw Error("Funding rollout does not match this pinned deployment/epoch.");
  const local = getConfiguredBayId();
  const configured = getConfiguredClusterBayCatalog().map((b) => b.bay_id);
  const multi = isMultiBayCluster() || configured.some((id) => id !== local);
  const registered = multi ? await listClusterBayRegistry() : [];
  if (multi && !registered.some((b) => b.bay_id === local))
    throw Error("Funding rollout bay registry is incomplete.");
  const expected = [
    ...new Set([local, ...configured, ...registered.map((b) => b.bay_id)]),
  ].sort();
  if (
    JSON.stringify(expected) !==
    JSON.stringify(manifest.bays.map((b) => b.bay_id).sort())
  )
    throw Error(
      "Funding rollout manifest does not cover the authoritative bay inventory.",
    );
  if (
    manifest.exposure_allocation &&
    fundingExposureAllocationDigest(manifest) !==
      process.env.COCALC_FUNDING_EXPOSURE_ALLOCATION_SHA256
  )
    throw Error(
      "Funding exposure allocation does not match the pinned deployment quota.",
    );
  return { ...result, bay: manifest.bays.find((b) => b.bay_id === local)! };
}

/** Pinned separately from the frequently renewed manifest. Changing quotas
 * requires draining/fencing the old allocation fleet, never a rolling edit.
 */
export function fundingExposureAllocationDigest(
  manifest: FundingRolloutManifest,
): string {
  if (!manifest.exposure_allocation)
    throw Error("Funding exposure allocation is missing.");
  return createHash("sha256")
    .update(
      stableStringify({
        deployment_id: manifest.deployment_id,
        allocation: {
          ...manifest.exposure_allocation,
          bay_quotas: [...manifest.exposure_allocation.bay_quotas].sort(
            (a, b) => a.bay_id.localeCompare(b.bay_id),
          ),
        },
      }),
    )
    .digest("hex");
}

export async function getProductionFundingExposureAllocation(): Promise<{
  allocation_id: string;
  manifest_digest: string;
  bay_id: string;
  quota_usd: string;
  site_ceiling_usd: string;
  expires_at: string;
}> {
  const { manifest, bay, digest } = await loadProductionFundingRollout();
  const allocation = manifest.exposure_allocation;
  if (!allocation) throw Error("Funding exposure allocation is missing.");
  return {
    allocation_id: allocation.id,
    manifest_digest: digest,
    bay_id: bay.bay_id,
    quota_usd: allocation.bay_quotas.find((q) => q.bay_id === bay.bay_id)!
      .amount_usd,
    site_ceiling_usd: allocation.site_ceiling_usd,
    expires_at: manifest.expires_at,
  };
}
